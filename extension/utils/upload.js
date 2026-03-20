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

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_RETRIES = 5;
const BACKEND_URL = 'http://localhost:3000';

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
    const folderId = await ensureDriveFolder(token);

    // Step 1: Get (or reuse) session URI
    let sessionUri = job.sessionUri;
    if (!sessionUri) {
      sessionUri = await initiateResumableUpload(token, folderId, blob.size);
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
  let offset = 0;
  let retries = 0;

  // Check how much was already uploaded (resume after restart)
  offset = await getUploadedOffset(sessionUri, blob.size);

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
      } else {
        // Exponential backoff
        const delay = Math.pow(2, retries) * 1000;
        await sleep(delay);
      }

      // Find actual offset from server before retrying
      offset = await getUploadedOffset(sessionUri, blob.size);
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

  if (res.status === 200 || res.status === 201) return totalSize; // already done
  if (res.status === 308) {
    const range = res.headers.get('Range');
    if (!range) return 0;
    const match = range.match(/bytes=0-(\d+)/);
    return match ? parseInt(match[1], 10) + 1 : 0;
  }
  return 0;
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

// ─── Drive folder ──────────────────────────────────────────────────────────────
async function ensureDriveFolder(token) {
  const stored = await new Promise(r =>
    chrome.storage.local.get(['driveFolderId'], d => r(d.driveFolderId))
  );
  if (stored) return stored;

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
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true, ...(forceRefresh ? { scopes: [] } : {}) }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

// ─── Notify backend ───────────────────────────────────────────────────────────
async function notifyBackend(job, retryCount = 0) {
  const MAX_BACKEND_RETRIES = 10;
  const RETRY_INTERVAL_MS   = 60_000;

  try {
    // Get a fresh token so the backend can download the file from Drive.
    // Tokens are valid for ~1 hour — enough time for the worker to process the job.
    const accessToken = await getAuthToken();

    const res = await fetch(`${BACKEND_URL}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId:       job.id,
        driveFileId: job.driveFileId,
        userEmail:   job.userEmail || '',
        accessToken,
      }),
    });

    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    await updateJob(job.id, { status: 'queued' });
  } catch (err) {
    console.warn(`[upload] Backend unreachable (attempt ${retryCount + 1}):`, err.message);
    if (retryCount < MAX_BACKEND_RETRIES) {
      setTimeout(() => notifyBackend(job, retryCount + 1), RETRY_INTERVAL_MS);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
