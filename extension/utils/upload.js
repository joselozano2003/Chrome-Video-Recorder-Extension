// utils/upload.js — Google Drive resumable upload
// Implements the 3-step resumable upload protocol:
//   1. POST → get a session URI
//   2. PUT chunks (5 MB each) with Content-Range headers
//   3. On failure, GET the session URI to find resume offset, then continue
//
// The session URI is stored in the job record so the upload can be resumed
// even after a browser restart.

import { getJob, updateJob } from './queue.js';
import { getRecording, deleteRecording } from './db.js';
import { BACKEND_URL } from '../config.js';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_RETRIES = 5;

// ─── Entry point ──────────────────────────────────────────────────────────────
/**
 * Start or resume uploading the recording for a given job.
 * Safe to call multiple times — idempotent (checks driveFileId first).
 * @param {string} jobId
 */
export async function startUpload(jobId) {
  const job = await getJob(jobId);
  if (!job) return;

  // Idempotency: already uploaded → skip straight to notifying backend
  if (job.driveFileId) {
    await notifyBackend(job);
    return;
  }

  await updateJob(jobId, { status: 'uploading', error: null });

  try {
    const blob = await getRecording(job.recordingId);
    if (!blob) throw new Error('Recording blob not found in IndexedDB');
    console.log(`[upload] Blob size: ${(blob.size / 1024 / 1024).toFixed(2)} MB, type: ${blob.type}`);

    const token = await getAuthToken();
    const rootFolderId = await ensureDriveFolder(token);

    // Get (or create) the per-recording session subfolder
    let sessionFolderId = job.sessionFolderId;
    if (!sessionFolderId) {
      sessionFolderId = await ensureSessionFolder(token, rootFolderId, job.createdAt);
      await updateJob(jobId, { sessionFolderId });
    }

    // Step 1: Get (or reuse) session URI
    let sessionUri = job.sessionUri;
    if (!sessionUri) {
      sessionUri = await initiateResumableUpload(token, sessionFolderId, blob.size);
      await updateJob(jobId, { sessionUri });
    }

    // Step 2: Upload in chunks
    const driveFileId = await uploadChunks(jobId, blob, sessionUri, token);

    const driveFileUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
    await updateJob(jobId, {
      status: 'uploaded',
      driveFileId,
      driveFileUrl,
      uploadProgress: 100,
    });

    // Clean up local blob — it's now safely on Drive
    await deleteRecording(job.recordingId);

    // Step 3: Notify backend to queue transcription
    await notifyBackend(await getJob(jobId));
  } catch (err) {
    console.error('[upload] Upload failed:', err);
    const job = await getJob(jobId);
    const retryCount = (job.retryCount || 0) + 1;
    await updateJob(jobId, {
      status: 'failed',
      error: err.message,
      retryCount,
    });
  }
}

// ─── Chunked upload ────────────────────────────────────────────────────────────
async function uploadChunks(jobId, blob, sessionUri, token) {
  let retries = 0;

  // Check how much was already uploaded (resume after restart).
  // If the upload was already completed (browser closed right after last chunk),
  // getUploadedOffset returns the driveFileId directly — don't re-upload.
  let { offset, driveFileId: resumeId } = await getUploadedOffset(sessionUri, blob.size);
  if (resumeId) return resumeId;

  while (offset < blob.size) {
    const end   = Math.min(offset + CHUNK_SIZE, blob.size);
    const chunk = blob.slice(offset, end);

    try {
      const result = await putChunk(sessionUri, chunk, offset, blob.size, token);

      if (result.driveFileId) {
        return result.driveFileId; // upload complete
      }

      offset = end;
      retries = 0;

      const progress = Math.round((offset / blob.size) * 100);
      await updateJob(jobId, { uploadProgress: progress });
    } catch (err) {
      if (retries >= MAX_RETRIES) throw err;

      if (err.status === 401) {
        token = await getAuthToken(true); // force refresh
      } else if (err.status === 404 || err.status === 410) {
        // Session URI expired (Drive sessions are valid for 7 days).
        // Clear it so startUpload() creates a fresh session on next run.
        await updateJob(jobId, { sessionUri: null });
        throw new Error('Upload session expired — will restart on next retry');
      } else {
        // Exponential backoff
        const delay = Math.pow(2, retries) * 1000;
        await sleep(delay);
      }

      // Re-check offset; Drive may have already received the last chunk
      const resume = await getUploadedOffset(sessionUri, blob.size);
      if (resume.driveFileId) return resume.driveFileId;
      offset = resume.offset;
      retries++;
    }
  }

  throw new Error('Upload loop ended without receiving file ID');
}

async function putChunk(sessionUri, chunk, offset, totalSize, token) {
  const end = offset + chunk.size - 1;
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Length': chunk.size,
      'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
      'Authorization': `Bearer ${token}`,
    },
    body: chunk,
  });

  if (res.status === 308) {
    // Incomplete — more chunks needed
    return {};
  }

  if (res.status === 200 || res.status === 201) {
    const data = await res.json();
    return { driveFileId: data.id };
  }

  const err = new Error(`PUT chunk failed: ${res.status}`);
  err.status = res.status;
  throw err;
}

async function getUploadedOffset(sessionUri, totalSize) {
  // Ask Drive how many bytes it has received
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Length': '0',
      'Content-Range': `bytes */${totalSize}`,
    },
  });

  if (res.status === 200 || res.status === 201) {
    // Upload already complete — extract the file ID so the caller can skip re-uploading.
    // This happens when the browser was closed after the last chunk landed but before
    // the driveFileId was persisted to storage.
    const data = await res.json();
    return { offset: totalSize, driveFileId: data.id };
  }
  if (res.status === 308) {
    const range = res.headers.get('Range');
    if (!range) return { offset: 0 };
    const match = range.match(/bytes=0-(\d+)/);
    return { offset: match ? parseInt(match[1], 10) + 1 : 0 };
  }
  return { offset: 0 };
}

// ─── Session initiation ────────────────────────────────────────────────────────
async function initiateResumableUpload(token, folderId, fileSize) {
  const metadata = {
    name: `recording-${Date.now()}.webm`,
    mimeType: 'video/webm',
    parents: [folderId],
  };

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/webm',
        'X-Upload-Content-Length': fileSize,
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!res.ok) throw new Error(`Failed to initiate upload: ${res.status}`);
  return res.headers.get('Location');
}

// ─── Drive folders ─────────────────────────────────────────────────────────────
async function ensureSessionFolder(token, rootFolderId, createdAt) {
  const name = `Recording — ${new Date(createdAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })}`;

  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    }),
  });
  if (!res.ok) throw new Error(`Failed to create session folder: ${res.status}`);
  const folder = await res.json();
  return folder.id;
}

async function ensureDriveFolder(token) {
  const stored = await new Promise(r =>
    chrome.storage.local.get(['driveFolderId'], d => r(d.driveFolderId))
  );

  if (stored) {
    // Verify the cached folder still exists and hasn't been trashed.
    // If the user deleted it, clear the cache so we recreate it below.
    try {
      const checkRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${stored}?fields=id,trashed`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (checkRes.ok) {
        const data = await checkRes.json();
        if (!data.trashed) return stored;
      }
    } catch { /* network error — fall through and recreate */ }
    chrome.storage.local.remove('driveFolderId');
  }

  // Search for existing folder
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name%3D'Tab+Recordings'+and+mimeType%3D'application%2Fvnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();

  if (searchData.files?.length) {
    const id = searchData.files[0].id;
    chrome.storage.local.set({ driveFolderId: id });
    return id;
  }

  // Create folder
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Tab Recordings',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const folder = await createRes.json();
  chrome.storage.local.set({ driveFolderId: folder.id });
  return folder.id;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────
function getAuthToken(forceRefresh = false) {
  if (!forceRefresh) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(token);
      });
    });
  }

  // Force-refresh: evict the cached token then fetch a new one.
  // This is necessary after multi-hour uploads where the cached token has expired.
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (staleToken) => {
      const evict = staleToken
        ? new Promise(r => chrome.identity.removeCachedAuthToken({ token: staleToken }, r))
        : Promise.resolve();

      evict.then(() => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(token);
        });
      });
    });
  });
}

// ─── Notify backend ───────────────────────────────────────────────────────────
async function notifyBackend(job) {
  try {
    // Force-refresh the token — the Drive upload may have taken hours,
    // so the cached token is very likely expired by the time we reach this step.
    const accessToken = await getAuthToken(true);

    const res = await fetch(`${BACKEND_URL}/jobs`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId:           job.id,
        driveFileId:     job.driveFileId,
        sessionFolderId: job.sessionFolderId || null,
        userEmail:       job.userEmail || '',
        createdAt:       job.createdAt,
        timeZone:        Intl.DateTimeFormat().resolvedOptions().timeZone,
        accessToken,
      }),
    });

    if (!res.ok) throw new Error(`Backend returned ${res.status}`);

    // Success — clear any previous unreachable error and move to queued
    await updateJob(job.id, { status: 'queued', error: null });
  } catch (err) {
    // Leave the job in 'uploaded' state so the alarm-based retry picks it up.
    // Surface the error in the popup so the user knows what's happening.
    console.warn('[upload] Backend unreachable — will retry on next alarm tick:', err.message);
    await updateJob(job.id, {
      error: `Server unreachable — retrying automatically. (${err.message})`,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
