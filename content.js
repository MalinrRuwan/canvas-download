// Course Material Downloader — content script.
// Runs in the module page (top frame) AND in Content Controller frames.
// - Top frame: shows the floating download button.
// - Vault iframe: on request, re-fetches the file same-origin (the browser
//   attaches the Referer + cookies automatically) and hands the bytes to
//   the background worker, which performs the actual save.

const BTN_ID = 'aws-custom-download-btn';
const isTopFrame = () => window === window.top;

// ── Floating button (top frame only) ─────────────────────────────────────────
function addDownloadButton(pdfUrl) {
    if (!isTopFrame()) return; // never inject buttons into the SCORM iframe
    if (document.getElementById(BTN_ID)) return; // duplicate-safe

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerHTML = '📥 Download Course PDF';

    btn.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        z-index: 2147483647;
        padding: 15px 25px;
        background-color: #ff9900;
        color: #232f3e;
        border: 2px solid #232f3e;
        border-radius: 8px;
        cursor: pointer;
        font-family: Arial, sans-serif;
        font-weight: bold;
        font-size: 16px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        transition: transform 0.2s, background-color 0.2s;
    `;

    const setText = (t) => { btn.innerHTML = t; };

    btn.onmouseover = () => { btn.style.transform = 'scale(1.05)'; };
    btn.onmouseout = () => { btn.style.transform = 'scale(1)'; };

    btn.addEventListener('click', () => {
        setText('⏳ Downloading...');
        chrome.runtime.sendMessage({ action: 'download', url: pdfUrl })
            .then((resp) => {
                if (resp && resp.ok) {
                    setTimeout(() => setText('📥 Download Course PDF'), 20000);
                } else {
                    const err = (resp && resp.error) || 'unknown error';
                    console.error('[CourseDownloader] failed to start:', err);
                    failButton(err);
                }
            })
            .catch((err) => {
                // "Extension context invalidated" → refresh the page after reloading the extension.
                console.error('[CourseDownloader] message error:', err);
                failButton(String(err));
            });
    });

    document.body.appendChild(btn);
}

function failButton(err) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.innerHTML = '⚠️ Failed — see console';
    btn.style.backgroundColor = '#d13212';
    btn.title = err; // hover to see the full error
}

// ── Messages ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'found_pdf') {
        addDownloadButton(request.url);
    } else if (request.action === 'fetch_and_download' && request.url) {
        // Sent by the background with {frameId} targeting this vault frame.
        fetchAndDownload(request.url, request.headers || [])
            .then((r) => sendResponse(r))
            .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true; // async response
    } else if (request.action === 'download_done') {
        const btn = document.getElementById(BTN_ID);
        if (btn) {
            btn.innerHTML = '✅ Saved — check your downloads';
            btn.style.backgroundColor = '#1a7f37';
        }
    } else if (request.action === 'download_error') {
        console.error('[CourseDownloader]', request.error);
        failButton(request.error || 'download failed');
    }
});

// Same-origin fetch inside the vault iframe: the browser attaches the
// Referer (the player page URL) and cookies the server expects.
// headers arrive as [{name, value}] → convert to a plain record for fetch().
function toFetchInit(headerPairs) {
    const out = {};
    for (const h of headerPairs || []) {
        if (h && h.name && h.value != null) out[h.name] = h.value;
    }
    return out;
}

async function fetchAndDownload(url, headers) {
    const init = {
        headers: toFetchInit(headers),
        credentials: 'include',
        cache: 'no-store' // never serve a cached empty body for this vault URL
    };

    let resp = await fetch(url, init);
    // Server claims zero bytes → likely a transient/cached empty response; retry once.
    const len = resp.headers.get('content-length');
    if (resp.ok && len !== null && Number(len) === 0) {
        console.warn('[CourseDownloader] content-length: 0 — retrying once');
        await new Promise((r) => setTimeout(r, 750));
        resp = await fetch(url, init);
    }

    console.info(
        `[CourseDownloader] iframe fetch → ${resp.status} ` +
        `content-length: ${resp.headers.get('content-length')} ` +
        `type: ${resp.headers.get('content-type')} ` +
        `final: ${resp.url.slice(0, 140)}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const blob = await resp.blob();
    console.info(`[CourseDownloader] iframe fetch body: ${blob.size} bytes`);
    if (blob.size === 0) {
        throw new Error('vault returned an empty body (see content-length above)');
    }

    // chrome.downloads is NOT available in content scripts — send the file
    // to the background worker for saving. IMPORTANT: raw ArrayBuffers do NOT
    // survive chrome.runtime.sendMessage (JSON serialization turns them into
    // {}), so build the data: URL here and send the base64 string instead.
    const dataUrl = await blobToDataUrl(blob);
    console.info(`[CourseDownloader] data URL ready (${dataUrl.length} chars)`);
    const reply = await chrome.runtime.sendMessage({
        action: 'save_blob',
        url,
        dataUrl,
        filename: guessFilename(url, resp)
    });
    if (!reply || !reply.ok) {
        throw new Error((reply && reply.error) || 'background failed to save the blob');
    }
    return { ok: true };
}

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000; // 32KB chunks — avoids call-stack limits
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${blob.type || 'application/pdf'};base64,${btoa(binary)}`;
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
