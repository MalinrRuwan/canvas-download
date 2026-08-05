<div align="center">

# 📥 Course Material Downloader

**One-click PDF downloads for AWS Academy / Canvas course modules.**

Tired of hunting through SCORM iframes for the PDF behind your course materials? This Chrome extension watches network traffic, detects the real file URL, and drops a floating **Download** button on the page.

</div>

---

## ✨ Features

- 🔍 **Detects PDFs automatically** — monitors network requests, so it works even when the file is loaded dynamically inside a cross-origin SCORM iframe (no URL in the page HTML).
- 🖱️ **Floating download button** — styled to match AWS branding, injected bottom-right the moment a file is found.
- 🗂️ **Save-as prompt** — choose where each file goes (or auto-save straight to Downloads).
- 🔐 **Header replay for protected files** — the original request's headers (`Referer`, auth tokens, …) are captured and replayed on the download, so vaults that reject header-less requests don't fail. If the server still refuses, it retries with a cookie-authenticated `fetch()` and downloads the resulting blob.
- 🚫 **Duplicate-safe** — only one button is ever shown, even if the same file is fetched multiple times.

## 🧠 How It Works

```
┌─────────────────────┐     webRequest      ┌──────────────────────────┐
│  Canvas module page │  ── detects .pdf ─▶ │  background.js (worker)  │
│  (SCORM iframe)     │                     └────────────┬─────────────┘
└─────────────────────┘                                  │ tabs.sendMessage
                                                         ▼
┌─────────────────────┐     found_pdf       ┌──────────────────────────┐
│  Floating button    │  ◀───────────────── │  content.js (page)       │
│  → chrome.downloads │                     └──────────────────────────┘
└─────────────────────┘
```

The actual PDF URL is never in the module page's HTML — AWS Academy loads it dynamically inside a cross-origin SCORM player (Content Controller). So instead of parsing the DOM, the extension:

1. **Background worker** listens to every network request via `webRequest`, captures the request's headers and frame into `storage.session`, and messages the tab that made the request (using `details.tabId` — reliable even for background tabs).
2. **Content script** receives the URL and injects a fixed-position button.
3. Clicking the button tries three download paths in order:
   - **Native** — `chrome.downloads.download()` with replayed headers (only headers XHR allows — `Referer`/`Origin`/`Sec-*` are rejected by the API, so they're filtered out).
   - **Iframe re-fetch** — the vault iframe re-fetches the file same-origin, where the browser attaches `Referer` + cookies automatically, then saves the blob.
   - **Worker fetch** — `fetch()` with `credentials: 'include'` + replayed headers, saved as a blob.

## 📦 Installation

1. Download / clone this repository and unzip it to a folder like `canvas-download`.
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
3. Toggle **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the `canvas-download` folder.
5. Open any course module item on AWS Academy — the button appears when a PDF is detected.

> 💡 Pin the extension so you can see it working, and check the **Service Worker** console (`chrome://extensions` → *Inspect views*) if something isn't firing.

## 🧰 Usage

| Action | Result |
|---|---|
| Open a module item containing a PDF | Orange **📥 Download Course PDF** button appears bottom-right |
| Click the button | Save-as dialog opens for the detected file |
| Hover the button | Subtle scale-up effect |

## 🔐 Permissions Explained

| Permission | Why it's needed |
|---|---|
| `downloads` | Lets the background worker save files via `chrome.downloads.download()` |
| `webRequest` | Monitors network traffic to catch the PDF/vault URLs **and capture their request headers** |
| `storage` | Persists captured headers in `storage.session` so they survive service-worker restarts |
| `<all_urls>` host access | Content Controller vault hosts can vary per course; this guarantees detection. Chrome will show a *"Read and change all your data on all websites"* warning — narrow the list in `manifest.json` if you see consistent hosts in DevTools |

## 📁 Project Structure

```
canvas-download/
├── manifest.json      # MV3 manifest — permissions, background worker, content script
├── background.js      # Network watcher + download handler
├── content.js         # Floating button injection + message listener
└── README.md
```

## 🎨 Customization

- **Button text / label** — edit `btn.innerHTML` in `content.js`.
- **Colors** — tweak the CSS in `btn.style.cssText` (default: AWS orange `#ff9900` on dark `#232f3e`).
- **Auto-save instead of prompting** — set `saveAs: false` in `background.js`.
- **Match more domains** — extend `matches` in `manifest.json` (e.g. other Instructure-hosted courses).

## ⚠️ Troubleshooting

| Problem | Fix |
|---|---|
| Button never appears | Confirm the file is a direct `.pdf` request (check DevTools → Network); some courses stream via blob URLs |
| Button appears on every page | It's `position: fixed` — close the tab or refresh; it only exists while the content script runs |
| Download fails | Three-tier fallback: native download → re-fetch from inside the SCORM iframe (where `Referer` is sent automatically) → worker `fetch()`. Keep the course tab open and logged in. If it still fails, open the service-worker console (`chrome://extensions` → *Inspect views*) — `[CourseDownloader]` logs show exactly which tier failed and why |

## 📄 License

MIT © [Malin Dhamsara](https://github.com/MalinrRuwan)
