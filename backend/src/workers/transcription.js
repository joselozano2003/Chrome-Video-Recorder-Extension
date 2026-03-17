// backend/src/workers/transcription.js — BullMQ queue + worker

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

// ─── Redis connection ──────────────────────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null, // required by BullMQ
});

// ─── Queue ────────────────────────────────────────────────────────────────────
export const transcriptionQueue = new Queue('transcription', { connection });

// ─── Worker ───────────────────────────────────────────────────────────────────
// Imported by server.js — the worker starts listening as soon as this module loads.

const worker = new Worker('transcription', async (job) => {
  const { jobId, driveFileId, userEmail } = job.data;
  console.log(`[worker] Processing job ${jobId} (driveFileId: ${driveFileId})`);

  // Phase 6: transcription logic will be added here
  // Phase 7: Google Docs + email will be added here

  // Placeholder — returns a stub result for now
  await job.updateProgress(10);

  // TODO (Phase 6): downloadAudio(driveFileId)
  // TODO (Phase 6): submitTranscription(audioUrl)
  // TODO (Phase 6): pollTranscription(transcriptId)
  // TODO (Phase 7): createTranscriptDoc(...)
  // TODO (Phase 7): sendEmail(userEmail, ...)

  await job.updateProgress(100);
  return { status: 'completed', jobId };
}, {
  connection,
  concurrency: 2,         // process up to 2 jobs at once
  lockDuration: 7_200_000 // 2-hour lock for long transcriptions
});

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err);
});
