// backend/src/workers/transcription.js — BullMQ queue + worker

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { uploadAudioFile, submitTranscription, pollTranscription } from '../services/assemblyai.js';
import { createTranscriptDoc } from '../services/googledocs.js';
import { sendCompletionEmail } from '../services/email.js';

// ─── Redis connection ──────────────────────────────────────────────────────────
const redisOpts = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
  ...(process.env.REDIS_TLS === 'true' && { tls: {} }),
  maxRetriesPerRequest: null,    // required by BullMQ
  keepAlive: 10000,              // send TCP keepalive every 10s
  retryStrategy: (times) => Math.min(times * 200, 5000),
};

// Queue and Worker get independent connections so reconnects don't interfere
const queueConnection  = new IORedis(redisOpts);
const workerConnection = new IORedis(redisOpts);

const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED']);

queueConnection.on('connect', () => console.log('[redis] Queue connection established'));
queueConnection.on('error', (err) => {
  if (TRANSIENT_CODES.has(err.code)) return;
  console.error('[redis] Queue connection error:', err.message);
});
workerConnection.on('error', (err) => {
  if (TRANSIENT_CODES.has(err.code)) return;
  console.error('[redis] Worker connection error:', err.message);
});

// ─── Queue ────────────────────────────────────────────────────────────────────
export const transcriptionQueue = new Queue('transcription', { connection: queueConnection });

// ─── Worker ───────────────────────────────────────────────────────────────────
const progress = (job, pct) => job.updateProgress(pct).catch(() => {}); // never fatal

const worker = new Worker('transcription', async (job) => {
  const { jobId, driveFileId, sessionFolderId, accessToken, userEmail, createdAt, timeZone = 'UTC' } = job.data;
  console.log(`[worker] Processing job ${jobId} (driveFileId: ${driveFileId})`);

  // ── Step 1: Download WebM from Google Drive ───────────────────────────────
  await progress(job, 10);
  console.log(`[worker] Downloading from Drive…`);

  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10 * 60 * 1000) }
  );

  if (!driveRes.ok) {
    throw new Error(`Drive download failed: ${driveRes.status} ${await driveRes.text()}`);
  }

  const audioBuffer = Buffer.from(await driveRes.arrayBuffer());
  console.log(`[worker] Downloaded ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // ── Step 2: Upload to AssemblyAI ──────────────────────────────────────────
  await progress(job, 30);
  console.log(`[worker] Uploading to AssemblyAI…`);

  const assemblyUrl = await uploadAudioFile(audioBuffer);
  console.log(`[worker] AssemblyAI upload complete`);

  // ── Step 3: Submit for transcription ──────────────────────────────────────
  await progress(job, 45);
  const transcriptId = await submitTranscription(assemblyUrl);
  console.log(`[worker] Transcription submitted: ${transcriptId}`);

  // ── Step 4: Poll until complete ───────────────────────────────────────────
  await progress(job, 50);
  console.log(`[worker] Polling transcription…`);

  const { text, utterances } = await pollTranscription(transcriptId, (status) => {
    console.log(`[worker] Job ${jobId} — transcription status: ${status}`);
  });

  console.log(`[worker] Transcription complete — ${text.length} chars, ${utterances.length} utterances`);

  // ── Step 5: Create Google Doc with transcript ─────────────────────────────
  await progress(job, 80);
  const recordingDate = new Date(createdAt);
  const title = `Transcript — ${recordingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone })}`;
  const driveUrl = `https://drive.google.com/file/d/${driveFileId}/view`;

  const { docId, docUrl } = await createTranscriptDoc(
    title,
    recordingDate.toISOString(),
    driveUrl,
    text,
    utterances,
    accessToken,
    sessionFolderId,
    timeZone,
  );
  console.log(`[worker] Google Doc created: ${docUrl}`);

  // ── Step 6: Send completion email ─────────────────────────────────────────
  const recipient = userEmail || process.env.NOTIFY_EMAIL;
  if (recipient) {
    const EMAIL_ATTEMPTS = 3;
    const EMAIL_DELAY_MS = 5_000;
    let emailSent = false;
    for (let attempt = 1; attempt <= EMAIL_ATTEMPTS; attempt++) {
      try {
        await sendCompletionEmail(recipient, driveUrl, docUrl, recordingDate.toISOString(), timeZone);
        console.log(`[worker] Email sent to ${recipient}`);
        emailSent = true;
        break;
      } catch (err) {
        console.warn(`[worker] Email attempt ${attempt}/${EMAIL_ATTEMPTS} failed: ${err.message}`);
        if (attempt < EMAIL_ATTEMPTS) await new Promise(r => setTimeout(r, EMAIL_DELAY_MS));
      }
    }
    if (!emailSent) console.warn(`[worker] Email delivery failed after ${EMAIL_ATTEMPTS} attempts — job still completed`);
  } else {
    console.warn(`[worker] No recipient email — set NOTIFY_EMAIL in .env`);
  }

  await progress(job, 100);

  return { status: 'completed', jobId, transcriptId, charCount: text.length, docId, docUrl };
}, {
  connection: workerConnection,
  concurrency: 2,
  lockDuration: 7_200_000, // 2-hour lock — transcription polling can take a while
});

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  if (TRANSIENT_CODES.has(err.code)) return;
  console.error('[worker] Worker error:', err);
});
