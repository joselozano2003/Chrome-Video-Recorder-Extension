// popup.js — UI logic for the Chrome Tab Recorder popup

const btnRecord = document.getElementById('btn-record');
const btnStop   = document.getElementById('btn-stop');
const recDot    = document.getElementById('rec-dot');
const statusEl  = document.getElementById('status');
const jobList   = document.getElementById('job-list');
const toggleSystemAudio = document.getElementById('toggle-system-audio');
const toggleMic         = document.getElementById('toggle-mic');

// ─── Load saved preferences ────────────────────────────────────────────────────
chrome.storage.local.get(['systemAudio', 'mic'], (prefs) => {
  if (prefs.systemAudio !== undefined) toggleSystemAudio.checked = prefs.systemAudio;
  if (prefs.mic        !== undefined) toggleMic.checked        = prefs.mic;
});

toggleSystemAudio.addEventListener('change', () => {
  chrome.storage.local.set({ systemAudio: toggleSystemAudio.checked });
});
toggleMic.addEventListener('change', () => {
  chrome.storage.local.set({ mic: toggleMic.checked });
});

// ─── Check current recording state ────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (response?.recording) setRecordingUI(true);
});

// ─── Record button ─────────────────────────────────────────────────────────────
btnRecord.addEventListener('click', () => {
  btnRecord.disabled = true;
  setStatus('Starting recording…');

  chrome.runtime.sendMessage({
    type: 'start-recording',
    systemAudio: toggleSystemAudio.checked,
    mic: toggleMic.checked,
  }, (response) => {
    if (response?.success) {
      setRecordingUI(true);
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
function setRecordingUI(isRecording) {
  btnRecord.disabled = isRecording;
  btnStop.disabled   = !isRecording;
  recDot.classList.toggle('recording', isRecording);
}

function setStatus(text) {
  statusEl.textContent = text;
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
