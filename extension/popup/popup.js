// popup.js — UI logic for the Chrome Tab Recorder popup

const btnRecord = document.getElementById('btn-record');
const btnStop   = document.getElementById('btn-stop');
const recDot    = document.getElementById('rec-dot');
const statusEl  = document.getElementById('status');
const timerEl   = document.getElementById('timer');
const jobList   = document.getElementById('job-list');
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
  if (!hasAudioSource && !toggleAudioOnly.checked) {
    setStatus('Enable at least one audio source or audio-only mode.');
    return;
  }
  if (toggleAudioOnly.checked && !hasAudioSource) {
    setStatus('Audio-only mode requires system audio or microphone.');
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
  setStatus('Stopping…');

  chrome.runtime.sendMessage({ type: 'stop-recording' }, (response) => {
    setRecordingUI(false);
    if (response?.success) {
      setStatus('Saved. Uploading…');
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

function jobCard(job) {
  const date = new Date(job.createdAt).toLocaleTimeString();
  const shortId = job.id.slice(0, 8);

  let progressHtml = '';
  if (job.status === 'uploading' && job.uploadProgress != null) {
    progressHtml = `
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${job.uploadProgress}%"></div>
      </div>`;
  }

  let linksHtml = '';
  if (job.driveFileUrl) linksHtml += `<a href="${job.driveFileUrl}" target="_blank">Drive</a>`;
  if (job.docUrl)       linksHtml += `<a href="${job.docUrl}" target="_blank">Transcript</a>`;
  if (linksHtml)        linksHtml = `<div class="job-links">${linksHtml}</div>`;

  const errorHtml = job.error
    ? `<div class="job-error">${escapeHtml(job.error)}</div>` : '';

  const retryHtml = job.status === 'failed'
    ? `<button class="btn-retry" data-job-id="${job.id}">Retry</button>` : '';

  return `
    <div class="job-card">
      <div class="job-header">
        <span class="job-id">${shortId}… · ${date}</span>
        <span class="badge badge-${job.status}">${job.status}</span>
      </div>
      ${progressHtml}
      ${linksHtml}
      ${errorHtml}
      ${retryHtml}
    </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
async function retryJob(jobId) {
  chrome.runtime.sendMessage({ type: 'retry-job', jobId }, () => {
    renderJobs();
  });
}

// ─── Poll for updates every 2 seconds ────────────────────────────────────────
renderJobs();
setInterval(renderJobs, 2000);
