// ─────────────────────────────────────────────────────────────────────────────
//  Course Material Downloader — background worker
//
//  Vault files are protected: they need the original request's context
//  (Referer, cookies, custom tokens). Download tiers:
//
//   A) Native chrome.downloads.download() with replayable headers.
//      NOTE: downloads API headers are "restricted to those allowed by
//      XMLHttpRequest" — passing Referer/User-Agent/Sec-* makes the call
//      THROW ("Unsafe request header name"). Those are filtered out.
//      If the original request carried a Referer (vaults that check it),
//      this tier is SKIPPED — the API can never send a Referer, so the
//      download would only 403.
//   B) Re-fetch from inside the SCORM iframe (same-origin → the browser
//      attaches the Referer + cookies automatically) → save the blob.
//   C) Worker fetch with credentials:'include' — last resort, no Referer.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_RE = /\.pdf|contentcontroller\.com\/vault\//i;
const LATEST_KEY = '_latest';

// XHR-forbidden headers — the downloads API and fetch() refuse to set these.
const FORBIDDEN_HEADERS =
    /^(accept-charset|accept-encoding|access-control-request-(headers|method)|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|permissions-policy|referer|te|trailer|transfer-encoding|upgrade|user-agent|via|x-http-method(-override)?)$/i;

const isTarget = (url) => TARGET_RE.test(url);

function sanitizeHeaders(requestHeaders) {
    const seen = new Set();
    const out = [];
    for (const h of requestHeaders || []) {
        const name = String(h.name || '').trim();
        const value = h.value == null ? '' : String(h.value).trim();
        if (!name) continue;
        if (!/^[\x20-\x7E]*$/.test(name + value)) continue;      // ASCII only
        if (FORBIDDEN_HEADERS.test(name)) continue;
        if (/^(proxy|sec)-/i.test(name)) continue;               // Proxy-*, Sec-*
        const key = name.toLowerCase();
        if (seen.has(key)) continue;                             // no duplicates
        seen.add(key);
        out.push({ name, value });
    }
    return out;
}

// fetch() needs a plain {name: value} record — NOT the API's [{name, value}]
// array. Passing the array throws "object must have a callable @@iterator".
function toFetchInit(headerPairs) {
    const out = {};
    for (const h of headerPairs || []) {
        if (h && h.name && h.value != null) out[h.name] = h.value;
    }
    return out;
}

// ── 1. Capture the original request: URL + headers + frame + referer flag ───
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (!isTarget(details.url) || !details.requestHeaders) return;

        const hadReferer = details.requestHeaders.some(
            (h) => h.name && h.name.toLowerCase() === 'referer'
        );

        const entry = {
            url: details.url,
            headers: sanitizeHeaders(details.requestHeaders),
            needsReferer: hadReferer,
            frameId: details.frameId != null ? details.frameId : -1,
            time: Date.now()
        };
        chrome.storage.session
            .set({ [details.url]: entry, [LATEST_KEY]: entry })
            .catch(() => {});

        console.info(
            `[CourseDownloader] captured ${entry.headers.length} headers (referer: ${hadReferer}) for ${details.url.slice(0, 120)}`
        );

        if (details.tabId > -1) {
            chrome.tabs.sendMessage(details.tabId, {
                action: 'found_pdf',
                url: details.url
            }).catch(() => {});
        }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
);

// ── 2. Button click handler ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'download' || !request.url) return;
    const tabId = sender.tab ? sender.tab.id : -1;
    download(request.url, tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
            console.error('[CourseDownloader] download failed:', err);
            sendResponse({ ok: false, error: String(err) });
        });
    return true; // async response
});

async function download(url, tabId) {
    const entry = await getStored(url, LATEST_KEY);
    const headers = (entry && entry.headers) || [];

    // Vault checks Referer → native tier would only 403 (and pollute the
    // downloads shelf with a failed item). Go straight to the fetch tiers.
    if (entry && entry.needsReferer) {
        console.info('[CourseDownloader] request carried a Referer — skipping native tier');
        return downloadViaFetch(url, tabId, headers);
    }

    // A) Native download — no re-fetch, native progress in the shelf.
    for (const hdrs of [headers, []]) {
        try {
            const id = await chrome.downloads.download({ url, headers: hdrs, saveAs: true });
            watchNative(id, url, tabId, headers);
            return;
        } catch (err) {
            console.warn(`[CourseDownloader] downloads.download threw (${hdrs.length} headers):`, err);
        }
    }

    return downloadViaFetch(url, tabId, headers);
}

function watchNative(downloadId, url, tabId, headers) {
    chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state) return;

        if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            notify(tabId, { action: 'download_done', url });
        } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            const err = (delta.error && delta.error.current) || 'UNKNOWN';
            if (err === 'USER_CANCELED') return;
            console.warn(`[CourseDownloader] native download interrupted (${err}) — retrying via fetch`);
            downloadViaFetch(url, tabId, headers).catch((e) => {
                console.error('[CourseDownloader] fetch fallback failed:', e);
                notify(tabId, { action: 'download_error', url, error: String(e) });
            });
        }
    });
}

// ── 3. Fetch tiers (B: from the iframe, C: from the worker) ──────────────────
async function downloadViaFetch(url, tabId, headers) {
    const entry = await getStored(url, LATEST_KEY);
    const frameId = entry && entry.frameId > 0 ? entry.frameId : null;

    // B) Re-fetch from inside the vault iframe. The vault URL is same-origin
    //    with the SCORM player page, so the browser attaches the full player
    //    URL as Referer + all cookies — exactly what the successful curl did.
    if (tabId > -1 && frameId) {
        try {
            const resp = await chrome.tabs.sendMessage(
                tabId,
                { action: 'fetch_and_download', url, headers },
                { frameId }
            );
            if (resp && resp.ok) {
                notify(tabId, { action: 'download_done', url });
                return;
            }
            console.warn('[CourseDownloader] iframe fetch refused:', resp && resp.error);
        } catch (err) {
            console.warn('[CourseDownloader] iframe fetch unavailable:', err);
        }
    }

    // C) Worker fetch — cookies + replayable headers, but NO Referer.
    for (const init of [toFetchInit(headers), {}]) {
        try {
            const resp = await fetch(url, { headers: init, credentials: 'include' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            await chrome.downloads.download({
                url: objectUrl,
                filename: guessFilename(url, resp),
                saveAs: true
            });
            notify(tabId, { action: 'download_done', url });
            return;
        } catch (err) {
            console.warn('[CourseDownloader] worker fetch attempt failed:', err);
        }
    }
    throw new Error('all download paths failed — check the service-worker console');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStored(url, latestKey) {
    return chrome.storage.session
        .get([url, latestKey])
        .then((res) => res[url] || res[latestKey] || null)
        .catch(() => null);
}

function notify(tabId, message) {
    if (tabId > -1) {
        chrome.tabs.sendMessage(tabId, message).catch(() => {});
    }
}

function guessFilename(url, resp) {
    const cd = resp && resp.headers && resp.headers.get
        ? resp.headers.get('content-disposition')
        : null;
    const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (m) return decodeURIComponent(m[1].replace(/"/g, ''));

    try {
        const path = new URL(url).pathname;
        const name = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
        if (!name) return 'course-material.pdf';
        return name.endsWith('.pdf') ? name : `${name}.pdf`;
    } catch {
        return 'course-material.pdf';
    }
}
