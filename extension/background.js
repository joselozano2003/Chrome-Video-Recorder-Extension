// background.js — Manifest V3 Service Worker
// IMPORTANT: Service workers can be stopped by Chrome at any time.
// Never rely on in-memory state — always persist to chrome.storage.local or IndexedDB.
//
// MV3 recording architecture:
//   1. background.js calls chrome.tabCapture.getMediaStreamId() → stream ID
//   2. background.js creates an offscreen document
//   3. offscreen.js receives the stream ID, calls getUserMedia, runs MediaRecorder

import { getJobs, createJob, updateJob, clearFinishedJobs } from './utils/queue.js';
import { startUpload } from './utils/upload.js';
import { cleanupOrphanedChunks, deleteRecording } from './utils/db.js';
import { BACKEND_URL } from './config.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// ─── Startup: Resume uploads + start backend polling alarm ─────────────────────
chrome.runtime.onStartup.addListener(() => { resumePendingJobs(); setupAlarm(); });
chrome.runtime.onInstalled.addListener(() => { resumePendingJobs(); setupAlarm(); });

function setupAlarm() {
  chrome.alarms.create('poll-backend', { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll-backend') {
    pollBackendJobs();
    retryUploadedJobs(); // re-notify backend for any jobs stuck in 'uploaded'
  }
});

// ─── Poll backend for queued/transcribing jobs ──────────────────────────────────
async function pollBackendJobs() {
  const jobs = await getJobs();
  const pending = jobs.filter(j => j.status === 'queued' || j.status === 'transcribing');
  if (!pending.length) return;

  for (const job of pending) {
    try {
      const res = await fetch(`${BACKEND_URL}/jobs/${job.id}`);
      if (!res.ok) continue;

      const data = await res.json();

      if (data.state === 'active') {
        await updateJob(job.id, { status: 'transcribing' });
      } else if (data.state === 'completed' && data.returnValue) {
        await updateJob(job.id, {
          status:       'completed',
          transcriptId: data.returnValue.transcriptId ?? null,
          docId:        data.returnValue.docId  ?? null,
          docUrl:       data.returnValue.docUrl ?? null,
          seekable:     data.returnValue.seekable ?? true,
        });
        console.log(`[background] Job ${job.id} completed — doc: ${data.returnValue.docUrl}`);
        notify(
          'Recording ready',
          'Your transcript and recording are available.',
          data.returnValue.docUrl ?? null
        );
      } else if (data.state === 'failed') {
        await updateJob(job.id, { status: 'failed', error: data.failReason || 'Backend job failed' });
        notify('Recording failed', 'Transcription failed. Open the extension to retry.');
      }
    } catch {
      // Backend unreachable — will retry next alarm tick
    }
  }
}

// ─── Retry 'uploaded' jobs on every alarm tick ─────────────────────────────────
// notifyBackend() uses no setTimeout (which dies with the SW) — instead it leaves
// the job in 'uploaded' and relies on this function to retry every minute.
async function retryUploadedJobs() {
  const jobs = await getJobs();
  for (const job of jobs.filter(j => j.status === 'uploaded')) {
    console.log(`[background] Retrying backend notification for uploaded job ${job.id}`);
    startUpload(job.id);
  }
}

async function resumePendingJobs() {
  const jobs = await getJobs();

  // Clean up IndexedDB chunks from recordings that crashed before assembling
  const knownRecordingIds = new Set(jobs.map(j => j.recordingId).filter(Boolean));
  cleanupOrphanedChunks(knownRecordingIds).catch(err =>
    console.warn('[background] Chunk cleanup failed:', err)
  );

  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'uploading') {
      console.log(`[background] Resuming job ${job.id} (${job.status})`);
      startUpload(job.id);
    } else if (job.status === 'uploaded') {
      // Backend notification was lost before browser closed — retry it
      console.log(`[background] Re-notifying backend for job ${job.id}`);
      startUpload(job.id); // upload.js skips the Drive upload and goes straight to notifyBackend
    }
  }
}

// ─── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'start-recording':
      handleStartRecording(message).then(sendResponse);
      return true;

    case 'stop-recording':
      handleStopRecording().then(sendResponse);
      return true;

    case 'retry-job':
      startUpload(message.jobId).then(() => sendResponse({ success: true }));
      return true;

    case 'get-status':
      isOffscreenAlive().then(alive => sendResponse({ recording: alive }));
      pollBackendJobs(); // refresh job statuses whenever popup opens
      return true;

    case 'poll-jobs':
      // Called by the popup every few seconds while it's open, so status stays
      // current without waiting for the 1-minute chrome.alarms tick.
      pollBackendJobs().then(() => sendResponse({ success: true }));
      return true;

    case 'mic-denied':
      notify('Microphone unavailable', 'Recording continuing without mic — microphone access was denied.');
      break;

    case 'clear-history':
      clearFinishedJobs().then(async (recordingIds) => {
        // Delete blobs from IndexedDB for all removed jobs
        await Promise.allSettled(recordingIds.map(id => deleteRecording(id)));
        sendResponse({ success: true });
      });
      return true;
  }
});

// ─── Start Recording ───────────────────────────────────────────────────────────
async function handleStartRecording(message) {
  // Guard against concurrent start attempts (double-click, rapid popup re-open).
  // Use storage so the flag survives across the async gap before offscreen is created.
  const { recordingInProgress } = await chrome.storage.local.get('recordingInProgress');
  if (recordingInProgress) return { success: false, error: 'Recording already in progress' };
  await chrome.storage.local.set({ recordingInProgress: true });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');

    // Get a stream ID — this is the MV3-safe way to do tab capture from a SW
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    // Ensure the offscreen document exists
    await ensureOffscreen();

    // Tell offscreen.js to open the stream and start MediaRecorder
    const response = await chrome.runtime.sendMessage({
      type: 'offscreen-start',
      streamId,
      options: {
        systemAudio: message.systemAudio !== false,
        mic: message.mic === true,
        audioOnly: message.audioOnly === true,
      },
    });

    if (!response?.success) throw new Error(response?.error || 'Offscreen start failed');

    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
    chrome.storage.local.set({ recordingStartAt: Date.now() });

    return { success: true };
  } catch (err) {
    console.error('[background] handleStartRecording:', err);
    chrome.storage.local.remove('recordingInProgress'); // release mutex on failure
    return { success: false, error: err.message };
  }
}

// ─── Stop Recording ────────────────────────────────────────────────────────────
async function handleStopRecording() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'offscreen-stop' });

    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.remove(['recordingStartAt', 'recordingInProgress']);
    await new Promise(r => setTimeout(r, 500)); // let offscreen logs flush
    await closeOffscreen();

    if (!response?.success) throw new Error(response?.error || 'Offscreen stop failed');

    // Fetch user email (best-effort — empty string if unavailable)
    const userEmail = await new Promise(resolve => {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        resolve(info?.email || '');
      });
    });

    // Offscreen doc only saves the blob — job creation and upload happen here
    // so they run in the service worker context where chrome.storage is always available.
    const job = await createJob(response.recordingId, userEmail);
    startUpload(job.id); // fire-and-forget — service worker keeps running

    return { success: true, jobId: job.id };
  } catch (err) {
    console.error('[background] handleStopRecording:', err);
    return { success: false, error: err.message };
  }
}

// ─── Offscreen document helpers ────────────────────────────────────────────────
async function ensureOffscreen() {
  // Always close any existing document first — a stale/zombie offscreen from a
  // previous session will silently swallow messages and block new recordings.
  const existing = await chrome.offscreen.hasDocument();
  if (existing) await chrome.offscreen.closeDocument();

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Record tab audio and video using MediaRecorder',
  });
}

async function closeOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) chrome.offscreen.closeDocument();
}

async function isOffscreenAlive() {
  return chrome.offscreen.hasDocument();
}

// ─── Notifications ─────────────────────────────────────────────────────────────
// Pending click URLs keyed by notification ID — avoids adding a new listener per notification
const pendingNotifUrls = {};

chrome.notifications.onClicked.addListener((notifId) => {
  const url = pendingNotifUrls[notifId];
  if (url) {
    chrome.tabs.create({ url });
    delete pendingNotifUrls[notifId];
  }
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClosed.addListener((notifId) => {
  delete pendingNotifUrls[notifId];
});

function notify(title, message, url = null) {
  const id = `rec-${Date.now()}`;
  if (url) pendingNotifUrls[id] = url;
  chrome.notifications.create(id, {
    type:    'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
  });
}
