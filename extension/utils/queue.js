// utils/queue.js — Local job queue backed by chrome.storage.local
// Jobs survive browser restarts. Never store video blobs here — only metadata.
//
// Job status flow:
//   pending → uploading → uploaded → queued → transcribing → completed
//                                                           ↘ failed

const STORAGE_KEY = 'jobs';

// ─── Read / Write helpers ──────────────────────────────────────────────────────
function readJobs() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve(data[STORAGE_KEY] || []);
    });
  });
}

function writeJobs(jobs) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: jobs }, resolve);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new job for a given recording.
 * @param {string} recordingId — IndexedDB key for the video blob
 * @returns {Object} the new job
 */
export async function createJob(recordingId) {
  const jobs = await readJobs();
  const job = {
    id:             crypto.randomUUID(),
    recordingId,
    status:         'pending',
    createdAt:      Date.now(),
    retryCount:     0,
    uploadProgress: 0,
    sessionUri:     null,   // resumable upload session URL
    driveFileId:    null,
    driveFileUrl:   null,
    transcriptId:   null,
    docId:          null,
    docUrl:         null,
    error:          null,
  };
  jobs.push(job);
  await writeJobs(jobs);
  return job;
}

/**
 * Update specific fields on a job (partial update).
 * @param {string} id      — job UUID
 * @param {Object} changes — fields to merge in
 */
export async function updateJob(id, changes) {
  const jobs = await readJobs();
  const idx  = jobs.findIndex(j => j.id === id);
  if (idx === -1) throw new Error(`Job not found: ${id}`);
  jobs[idx] = { ...jobs[idx], ...changes };
  await writeJobs(jobs);
  return jobs[idx];
}

/**
 * Get all jobs.
 * @returns {Object[]}
 */
export async function getJobs() {
  return readJobs();
}

/**
 * Get a single job by ID.
 * @param {string} id
 * @returns {Object|null}
 */
export async function getJob(id) {
  const jobs = await readJobs();
  return jobs.find(j => j.id === id) ?? null;
}
