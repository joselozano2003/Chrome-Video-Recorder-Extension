const btn = document.getElementById('btn');
const msg = document.getElementById('msg');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  msg.textContent = 'Requesting access…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    msg.textContent = 'Microphone access granted! You can close this tab.';
    btn.textContent = '✓ Granted';
    // Notify the extension that permission is now available
    chrome.runtime.sendMessage({ type: 'mic-permission-granted' });
  } catch (err) {
    msg.textContent = 'Permission denied. Please allow microphone access in Chrome site settings.';
    btn.disabled = false;
  }
});
