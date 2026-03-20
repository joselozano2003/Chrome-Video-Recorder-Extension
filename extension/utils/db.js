// utils/db.js — IndexedDB wrapper for storing large video blobs
// Uses the native IndexedDB API directly (no extra library needed in MV3).
// chrome.storage.local has a 10 MB limit — IndexedDB can hold gigabytes.
//
// Stores:
//   recordings — final assembled blobs  { id, blob, savedAt }
//   chunks     — in-flight recording chunks { recordingId, index, data }

import { fixWebmDuration } from './fixWebmDuration.js';

const DB_NAME    = 'TabRecorder';
const DB_VERSION = 2;
const REC_STORE   = 'recordings';
const CHUNK_STORE = 'chunks';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(REC_STORE)) {
        db.createObjectStore(REC_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const cs = db.createObjectStore(CHUNK_STORE, { keyPath: ['recordingId', 'index'] });
        cs.createIndex('byRecordingId', 'recordingId');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Append a single MediaRecorder chunk to IndexedDB as it arrives.
 * Called from ondataavailable — keeps RAM flat for long recordings.
 */
export async function appendChunk(recordingId, index, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).put({ recordingId, index, data });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Chunk write aborted'));
  });
}

/**
 * Read all chunks for a recording, assemble into a single Blob, save to
 * the recordings store, then delete the raw chunks.
 * @param {string} recordingId
 * @param {number} [durationMs] — actual recording duration; patches WebM header for seekability
 */
export async function assembleAndSave(recordingId, durationMs = 0) {
  const db = await openDB();

  // 1. Read all chunks in order
  const chunks = await new Promise((resolve, reject) => {
    const tx  = db.transaction(CHUNK_STORE, 'readonly');
    const req = tx.objectStore(CHUNK_STORE).index('byRecordingId').getAll(recordingId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  chunks.sort((a, b) => a.index - b.index);

  // 2. Assemble blob and patch duration for seekability
  const raw  = new Blob(chunks.map(c => c.data), { type: 'video/webm' });
  const blob = durationMs > 0 ? await fixWebmDuration(raw, durationMs) : raw;

  // 3. Save to recordings store
  await new Promise((resolve, reject) => {
    const tx = db.transaction(REC_STORE, 'readwrite');
    tx.objectStore(REC_STORE).put({ id: recordingId, blob, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error('Recording save aborted'));
  });

  // 4. Delete raw chunks
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(CHUNK_STORE, 'readwrite');
    const store = tx.objectStore(CHUNK_STORE);
    for (const chunk of chunks) store.delete([chunk.recordingId, chunk.index]);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Retrieve a recording Blob from IndexedDB.
 */
export async function getRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(REC_STORE, 'readonly');
    const req = tx.objectStore(REC_STORE).get(id);
    req.onsuccess = () => resolve(req.result?.blob ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Delete a recording from IndexedDB after it has been uploaded.
 */
export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(REC_STORE, 'readwrite');
    const req = tx.objectStore(REC_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
