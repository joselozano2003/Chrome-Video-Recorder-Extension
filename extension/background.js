// background.js — Manifest V3 Service Worker
// IMPORTANT: Service workers can be stopped by Chrome at any time.
// Never rely on in-memory state. Always persist to chrome.storage.local or IndexedDB.

import { createJob, updateJob, getJobs } from './utils/queue.js';
import { saveRecording } from './utils/db.js';
import { startUpload } from './utils/upload.js';

// ─── State (non-persistent — only used while service worker is alive) ──────────
let mediaRecorder = null;
let recordingChunks = [];
let activeStream = null;
let activeTabId = null;

// ─── Startup: Resume any pending jobs ─────────────────────────────────────────
chrome.runtime.onStartup.addListener(resumePendingJobs);
chrome.runtime.onInstalled.addListener(resumePendingJobs);

async function resumePendingJobs() {
  const jobs = await getJobs();
  const resumable = jobs.filter(j =>
    j.status === 'pending' || j.status === 'uploading'
  );
  for (const job of resumable) {
    console.log(`[background] Resuming job ${job.id} (status: ${job.status})`);
    startUpload(job.id);
  }
}

// ─── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'start-recording':
      handleStartRecording(message, sendResponse);
      return true; // keep channel open for async response

    case 'stop-recording':
      handleStopRecording(sendResponse);
      return true;

    case 'get-status':
      sendResponse({ recording: mediaRecorder?.state === 'recording' });
      break;

    default:
      console.warn('[background] Unknown message type:', message.type);
  }
});

// ─── Start Recording ───────────────────────────────────────────────────────────
async function handleStartRecording(message, sendResponse) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    sendResponse({ success: false, error: 'Already recording' });
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;

    const audioConstraints = {
      audio: message.systemAudio !== false,
      video: true,
    };

    // chrome.tabCapture.capture must be called from an event context
    chrome.tabCapture.capture(audioConstraints, (stream) => {
      if (chrome.runtime.lastError || !stream) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Failed to capture tab' });
        return;
      }

      activeStream = stream;
      recordingChunks = [];

      mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9,opus',
        // chunks every 1 second — critical for memory management
        videoBitsPerSecond: 2500000,
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunks.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('[background] MediaRecorder error:', event.error);
      };

      // 1000ms timeslice — writes chunks continuously instead of one huge blob
      mediaRecorder.start(1000);

      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });

      sendResponse({ success: true });
    });
  } catch (err) {
    console.error('[background] handleStartRecording error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Stop Recording ────────────────────────────────────────────────────────────
async function handleStopRecording(sendResponse) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    sendResponse({ success: false, error: 'Not currently recording' });
    return;
  }

  mediaRecorder.onstop = async () => {
    try {
      // Stop all tracks to release the tab stream
      activeStream?.getTracks().forEach(t => t.stop());
      activeStream = null;

      const blob = new Blob(recordingChunks, { type: 'video/webm' });
      recordingChunks = [];

      const recordingId = crypto.randomUUID();
      await saveRecording(recordingId, blob);
      console.log(`[background] Recording saved: ${recordingId} (${blob.size} bytes)`);

      // Create a job record immediately — this persists even if browser closes
      const job = await createJob(recordingId);
      console.log(`[background] Job created: ${job.id}`);

      // Kick off upload
      startUpload(job.id);

      chrome.action.setBadgeText({ text: '' });

      sendResponse({ success: true, jobId: job.id });
    } catch (err) {
      console.error('[background] handleStopRecording error:', err);
      sendResponse({ success: false, error: err.message });
    }
  };

  mediaRecorder.stop();
}
