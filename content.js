// Function to inject the floating button
function addDownloadButton(pdfUrl) {
    // Prevent adding multiple buttons if multiple PDFs load
    if (document.getElementById('aws-custom-download-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'aws-custom-download-btn';
    btn.innerHTML = '📥 Download Course PDF';

    // Style the button so it floats clearly over the course material
    btn.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        z-index: 2147483647; /* Maximum z-index */
        padding: 15px 25px;
        background-color: #ff9900; /* AWS Orange */
        color: #232f3e; /* AWS Dark Gray */
        border: 2px solid #232f3e;
        border-radius: 8px;
        cursor: pointer;
        font-family: Arial, sans-serif;
        font-weight: bold;
        font-size: 16px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        transition: transform 0.2s, background-color 0.2s;
    `;

    // Add hover effects
    btn.onmouseover = () => { btn.style.transform = 'scale(1.05)'; };
    btn.onmouseout = () => { btn.style.transform = 'scale(1)'; };

    // When clicked, tell the background script to download the file
    btn.addEventListener('click', () => {
        btn.innerHTML = '⏳ Downloading...';
        chrome.runtime.sendMessage({ action: 'download', url: pdfUrl });

        // Reset button text after a short delay
        setTimeout(() => {
            btn.innerHTML = '📥 Download Course PDF';
        }, 2000);
    });

    document.body.appendChild(btn);
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'found_pdf') {
        // The background script found the PDF URL in the network traffic
        addDownloadButton(request.url);
    }
});
