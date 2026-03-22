// popup.js — UI logic for the Chrome Tab Recorder popup

const btnRecord       = document.getElementById('btn-record');
const btnStop         = document.getElementById('btn-stop');
const recDot          = document.getElementById('rec-dot');
const statusEl        = document.getElementById('status');
const timerEl         = document.getElementById('timer');
const jobList         = document.getElementById('job-list');
const btnClearHistory = document.getElementById('btn-clear-history');
const toggleSystemAudio = document.getElementById('toggle-system-audio');
const toggleMic         = document.getElementById('toggle-mic');
const toggleAudioOnly   = document.getElementById('toggle-audio-only');

let timerInterval = null;

// ─── Load saved preferences ────────────────────────────────────────────────────
chrome.storage.local.get(['systemAudio', 'mic', 'audioOnly'], (prefs) => {
  if (prefs.systemAudio !== undefined) toggleSystemAudio.checked = prefs.systemAudio;
  if (prefs.mic        !== undefined) toggleMic.checked         = prefs.mic;
  if (prefs.audioOnly  !== undefined) toggleAudioOnly.checked   = prefs.audioOnly;
});

toggleSystemAudio.addEventListener('change', () => {
  chrome.storage.local.set({ systemAudio: toggleSystemAudio.checked });
});
toggleMic.addEventListener('change', () => {
  chrome.storage.local.set({ mic: toggleMic.checked });
});
toggleAudioOnly.addEventListener('change', () => {
  chrome.storage.local.set({ audioOnly: toggleAudioOnly.checked });
});

// ─── Check current recording state ────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (response?.recording) {
    chrome.storage.local.get(['recordingStartAt'], (data) => {
      setRecordingUI(true, data.recordingStartAt || Date.now());
    });
  }
});

// ─── Record button ─────────────────────────────────────────────────────────────
btnRecord.addEventListener('click', async () => {
  const hasAudioSource = toggleSystemAudio.checked || toggleMic.checked;
  if (!hasAudioSource) {
    setStatus('Enable system audio or microphone to record.');
    return;
  }

  btnRecord.disabled = true;
  setStatus('Starting recording…');

  // If mic is enabled, ensure permission is granted before proceeding.
  // getUserMedia in the popup is blocked by Chrome — we use a dedicated tab instead.
  if (toggleMic.checked) {
    const state = await navigator.permissions.query({ name: 'microphone' });
    if (state.state !== 'granted') {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
      setRecordingUI(false);
      setStatus('Grant mic access in the new tab, then record again.');
      return;
    }
  }

  chrome.runtime.sendMessage({
    type: 'start-recording',
    systemAudio: toggleSystemAudio.checked,
    mic: toggleMic.checked,
    audioOnly: toggleAudioOnly.checked,
  }, (response) => {
    if (response?.success) {
      chrome.storage.local.get(['recordingStartAt'], (data) => {
        setRecordingUI(true, data.recordingStartAt || Date.now());
      });
      setStatus('Recording…');
    } else {
      setRecordingUI(false);
      setStatus(`Error: ${response?.error || 'Unknown error'}`);
    }
  });
});

// ─── Stop button ───────────────────────────────────────────────────────────────
btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  stopTimer(); // stop immediately — don't wait for async response
  recDot.classList.remove('recording');
  setStatus('Stopping…');

  chrome.runtime.sendMessage({ type: 'stop-recording' }, (response) => {
    setRecordingUI(false);
    if (response?.success) {
      setStatus('Saved locally. Starting upload…');
      renderJobs(); // refresh immediately
    } else {
      setStatus(`Error: ${response?.error || 'Unknown error'}`);
    }
  });
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setRecordingUI(isRecording, startMs = null) {
  btnRecord.disabled = isRecording;
  btnStop.disabled   = !isRecording;
  recDot.classList.toggle('recording', isRecording);
  if (isRecording && startMs) {
    startTimer(startMs);
  } else {
    stopTimer();
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function startTimer(startMs) {
  stopTimer();
  const update = () => {
    const elapsed = Date.now() - startMs;
    const s = Math.floor(elapsed / 1000) % 60;
    const m = Math.floor(elapsed / 60000) % 60;
    const h = Math.floor(elapsed / 3600000);
    const pad = n => String(n).padStart(2, '0');
    timerEl.textContent = h > 0
      ? `${pad(h)}:${pad(m)}:${pad(s)}`
      : `${pad(m)}:${pad(s)}`;
  };
  update();
  timerInterval = setInterval(update, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

// ─── Job list rendering ───────────────────────────────────────────────────────
async function renderJobs() {
  const jobs = await getJobs();

  if (!jobs.length) {
    jobList.innerHTML = '<div class="no-jobs">No recordings yet.</div>';
    return;
  }

  // Sort newest first
  jobs.sort((a, b) => b.createdAt - a.createdAt);

  jobList.innerHTML = jobs.map(jobCard).join('');

  // Wire retry buttons
  jobList.querySelectorAll('.btn-retry').forEach(btn => {
    btn.addEventListener('click', () => retryJob(btn.dataset.jobId));
  });
}

function formatJobDate(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
}

function jobCard(job) {
  const date    = formatJobDate(job.createdAt);
  const shortId = job.id.slice(0, 8);

  let progressHtml = '';
  if (job.status === 'uploading' && job.uploadProgress != null) {
    const pct = Math.min(100, Math.max(0, Number(job.uploadProgress) || 0));
    progressHtml = `
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>`;
  }

  const safeUrl = (url) => (typeof url === 'string' && url.startsWith('https://')) ? url : null;
  let linksHtml = '';
  if (safeUrl(job.driveFileUrl)) linksHtml += `<a href="${job.driveFileUrl}" target="_blank">Drive</a>`;
  if (safeUrl(job.docUrl))       linksHtml += `<a href="${job.docUrl}" target="_blank">Transcript</a>`;
  if (linksHtml)        linksHtml = `<div class="job-links">${linksHtml}</div>`;

  const errorHtml = job.error
    ? `<div class="job-error">${escapeHtml(job.error)}</div>` : '';

  const seekableWarn = job.status === 'completed' && job.seekable === false
    ? `<div class="job-warning">Recording saved as .webm — seekability limited</div>` : '';

  const retryCount = job.retryCount > 0 ? ` (attempt ${job.retryCount + 1})` : '';
  // Show retry button for failed jobs AND for uploaded jobs where backend notification failed
  const showRetry = job.status === 'failed' || (job.status === 'uploaded' && job.error);
  const retryLabel = job.status === 'uploaded' ? 'Notify server' : `Retry${retryCount}`;
  const retryHtml = showRetry
    ? `<button class="btn-retry" data-job-id="${job.id}">${retryLabel}</button>` : '';

  return `
    <div class="job-card">
      <div class="job-header">
        <span class="job-id">${shortId}… · ${date}</span>
        <span class="badge badge-${job.status}">${job.status}</span>
      </div>
      ${progressHtml}
      ${linksHtml}
      ${seekableWarn}
      ${errorHtml}
      ${retryHtml}
    </div>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Read jobs from chrome.storage ────────────────────────────────────────────
function getJobs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['jobs'], (data) => {
      resolve(data.jobs || []);
    });
  });
}

// ─── Retry a failed job ───────────────────────────────────────────────────────
const retryingJobs = new Set(); // debounce — prevent double-clicks

async function retryJob(jobId) {
  if (retryingJobs.has(jobId)) return;
  retryingJobs.add(jobId);

  const btn = jobList.querySelector(`.btn-retry[data-job-id="${jobId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }

  chrome.runtime.sendMessage({ type: 'retry-job', jobId }, () => {
    retryingJobs.delete(jobId);
    renderJobs();
  });
}

// ─── Clear history ────────────────────────────────────────────────────────────
btnClearHistory.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clear-history' }, () => renderJobs());
});

// ─── Render loop ──────────────────────────────────────────────────────────────
// Render from local storage every 2 seconds (cheap — no network).
// Also ask the background to fetch fresh status from the backend every 5 seconds
// so the popup doesn't have to wait for the 1-minute chrome.alarms tick.
renderJobs();
setInterval(renderJobs, 2000);
setInterval(() => chrome.runtime.sendMessage({ type: 'poll-jobs' }), 5000);
