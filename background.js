// ─────────────────────────────────────────────────────────────────────────────
//  Course Material Downloader — background worker
//
//  The Content Controller vault serves files ONLY to requests that carry the
//  right headers (Referer, Origin, Authorization, custom tokens, ...).
//  A bare chrome.downloads.download(url) is rejected (401/403).
//
//  Strategy:
//   1. Observe the original PDF/vault request with webRequest and capture
//      its request headers (persisted in storage.session so they survive
//      service-worker restarts).
//   2. On button click, replay those headers on chrome.downloads.download().
//   3. If the download is interrupted (server still refuses), fall back to a
//      fetch() with credentials:'include' + the full header set, then
//      download the resulting blob.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_RE = /\.pdf|contentcontroller\.com\/vault\//i;
const LATEST_KEY = '_latest';

// Headers that must NOT be replayed manually:
//  - Cookie/Cookie2 ... the browser's cookie jar is sent automatically by both
//    chrome.downloads and fetch(); a manual Cookie header would duplicate or
//    override it and can break auth.
//  - Host / Content-Length / Accept-Encoding ... set by the network stack.
const SKIP_HEADERS = /^(cookie|cookie2|host|content-length|accept-encoding)$/i;

const isTarget = (url) => TARGET_RE.test(url);

// ── 1. Capture headers of the original PDF/vault request ────────────────────
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (!isTarget(details.url) || !details.requestHeaders) return;

        const headers = details.requestHeaders
            .filter((h) => !SKIP_HEADERS.test(h.name))
            .map((h) => ({ name: h.name, value: h.value }));

        const entry = { url: details.url, headers, time: Date.now() };
        chrome.storage.session
            .set({ [details.url]: entry, [LATEST_KEY]: entry })
            .catch(() => {});

        // Tell the page a file was found so it can show the button.
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

// ── 2. Handle the button click: download WITH the captured headers ──────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download' && request.url) {
        const tabId = sender.tab ? sender.tab.id : -1;
        downloadWithHeaders(request.url, tabId)
            .then(() => sendResponse({ ok: true }))
            .catch((err) => {
                console.error('Download failed to start:', err);
                sendResponse({ ok: false, error: String(err) });
            });
        return true; // async response
    }
});

async function downloadWithHeaders(url, tabId) {
    const entry = await getStored(url, LATEST_KEY);
    const headers = (entry && entry.headers) || [];

    // Save-as prompt; native progress in the Chrome shelf.
    const downloadId = await chrome.downloads.download({
        url,
        headers,
        saveAs: true
    });

    // Watch it: on interruption (auth rejected, network error) retry via fetch.
    trackDownload(downloadId, url, tabId);
}

function trackDownload(downloadId, url, tabId) {
    const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;

        if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            notify(tabId, { action: 'download_done', url });
        } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            const err = (delta.error && delta.error.current) || 'UNKNOWN';
            // Closing the save-as dialog is not a failure.
            if (err !== 'USER_CANCELED') {
                console.warn(`Direct download interrupted (${err}), retrying via fetch`);
                fetchAndDownload(url, tabId);
            }
        }
    };
    chrome.downloads.onChanged.addListener(onChanged);
}

// ── 3. Fallback: fetch with cookies + full headers, download the blob ───────
async function fetchAndDownload(url, tabId) {
    const entry = await getStored(url, LATEST_KEY);
    const headers = (entry && entry.headers) || [];

    try {
        const resp = await fetch(url, { headers, credentials: 'include' });
        if (!resp.ok) {
            throw new Error(`Server responded ${resp.status} ${resp.statusText}`);
        }
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        await chrome.downloads.download({
            url: objectUrl,
            filename: guessFilename(url, resp),
            saveAs: true
        });
        notify(tabId, { action: 'download_done', url });
    } catch (err) {
        console.error('Fallback download failed:', err);
        notify(tabId, { action: 'download_error', url, error: String(err) });
    }
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
    // Prefer the server's Content-Disposition if present.
    const cd = resp && resp.headers && resp.headers.get
        ? resp.headers.get('content-disposition')
        : null;
    const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (m) return decodeURIComponent(m[1].replace(/"/g, ''));

    // Otherwise derive it from the URL path (query strings like ?token= are ignored).
    try {
        const path = new URL(url).pathname;
        const name = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
        if (!name) return 'course-material.pdf';
        return name.endsWith('.pdf') ? name : `${name}.pdf`;
    } catch {
        return 'course-material.pdf';
    }
}
