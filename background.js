// Listen to all network requests
chrome.webRequest.onBeforeRequest.addListener(
    function(details) {
        // Check if the network request is fetching a PDF or hitting the content vault
        if (details.url.includes('.pdf') || details.url.includes('contentcontroller.com/vault/')) {

            // Send the detected URL to the tab that made the request
            // (details.tabId is more reliable than querying the active tab,
            //  since the request may come from a frame in the visible tab)
            if (details.tabId > -1) {
                chrome.tabs.sendMessage(details.tabId, {
                    action: 'found_pdf',
                    url: details.url
                }).catch(() => {
                    // Ignore errors if the content script isn't ready yet
                });
            }
        }
    },
    {urls: ["<all_urls>"]},
    []
);

// Listen for the download command from the injected button
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download' && request.url) {
        chrome.downloads.download({
            url: request.url,
            saveAs: true // Prompts the user where to save. Change to false to auto-save to Downloads.
        });
    }
});
