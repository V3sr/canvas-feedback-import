(async function () {
  const msg = document.getElementById('msg');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url ? new URL(tab.url) : null;
  if (!url || url.origin !== 'https://canvas.ubc.ca' || !/^\/courses\/\d+/.test(url.pathname)) {
    msg.textContent = 'Open a course on canvas.ubc.ca (any page inside the course), then click this again.';
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cfi-toggle' });
    window.close();
  } catch (e) {
    msg.textContent = 'Refresh the Canvas page once (the extension was installed or updated after it loaded), then click this again.';
  }
})();
