// utils/db.js — IndexedDB wrapper for storing large video blobs
// Uses the native IndexedDB API directly (no extra library needed in MV3).
// chrome.storage.local has a 10 MB limit — IndexedDB can hold gigabytes.

const DB_NAME    = 'TabRecorder';
const DB_VERSION = 1;
const STORE      = 'recordings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess  = () => resolve(req.result);
    req.onerror    = () => reject(req.error);
  });
}

/**
 * Save a recording Blob to IndexedDB.
 * @param {string} id   — UUID for this recording
 * @param {Blob}   blob — The video/webm Blob
 */
export async function saveRecording(id, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req   = store.put({ id, blob, savedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Retrieve a recording Blob from IndexedDB.
 * @param {string} id
 * @returns {Blob|null}
 */
export async function getRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req   = store.get(id);
    req.onsuccess = () => resolve(req.result?.blob ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Delete a recording from IndexedDB after it has been uploaded.
 * @param {string} id
 */
export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req   = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
