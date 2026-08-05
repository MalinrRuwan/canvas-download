// Course Material Downloader — content script.
// Runs in the module page (top frame) AND in Content Controller frames.
// - Top frame: shows the floating download button.
// - Vault iframe: on request, re-fetches the file same-origin (the browser
//   attaches the Referer + cookies automatically) and saves it as a blob.

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
    const resp = await fetch(url, { headers: toFetchInit(headers), credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
        url: objectUrl,
        filename: guessFilename(url, resp),
        saveAs: true
    });
    return { ok: true };
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
