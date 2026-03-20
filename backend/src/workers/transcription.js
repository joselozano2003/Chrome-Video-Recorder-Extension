// backend/src/workers/transcription.js — BullMQ queue + worker

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { uploadAudio, submitTranscription, pollTranscription } from '../services/assemblyai.js';
import { createTranscriptDoc } from '../services/googledocs.js';
import { sendCompletionEmail } from '../services/email.js';

/** Remux a WebM buffer through FFmpeg to add Duration + Cues (seek index). */
async function remuxToMp4(inputBuffer) {
  const id  = Date.now();
  const inp = join(tmpdir(), `rec-in-${id}.webm`);
  const out = join(tmpdir(), `rec-out-${id}.mp4`);
  try {
    await writeFile(inp, inputBuffer);
    // Copy video track (H.264 or VP8), transcode Opus → AAC for MP4 compatibility
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', inp, '-c:v', 'copy', '-c:a', 'aac', out], { stdio: 'pipe' },
        (err) => err ? reject(err) : resolve());
    });
    return { buffer: await readFile(out), mimeType: 'video/mp4', ext: 'mp4' };
  } finally {
    await Promise.allSettled([unlink(inp), unlink(out)]);
  }
}

// ─── Redis connection ──────────────────────────────────────────────────────────
const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null, // required by BullMQ
});

// ─── Queue ────────────────────────────────────────────────────────────────────
export const transcriptionQueue = new Queue('transcription', { connection });

// ─── Worker ───────────────────────────────────────────────────────────────────
const worker = new Worker('transcription', async (job) => {
  const { jobId, driveFileId, accessToken, userEmail } = job.data;
  console.log(`[worker] Processing job ${jobId} (driveFileId: ${driveFileId})`);

  // ── Step 1: Download audio from Google Drive ───────────────────────────────
  await job.updateProgress(10);
  console.log(`[worker] Downloading from Drive…`);

  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!driveRes.ok) {
    throw new Error(`Drive download failed: ${driveRes.status} ${await driveRes.text()}`);
  }

  const rawBuffer = Buffer.from(await driveRes.arrayBuffer());
  console.log(`[worker] Downloaded ${(rawBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // ── Step 1b: Remux with FFmpeg to add Duration + seek index ───────────────
  let audioBuffer = rawBuffer;
  try {
    const { buffer, mimeType } = await remuxToMp4(rawBuffer);
    audioBuffer = buffer;
    console.log(`[worker] Remuxed to MP4 — ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

    // Replace the Drive file content with the seekable MP4
    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType }, body: audioBuffer }
    );

    // Rename the file to .mp4
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaRes.ok) {
      const { name } = await metaRes.json();
      const mp4Name = name.replace(/\.webm$/i, '.mp4');
      await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: mp4Name }),
      });
    }
    console.log(`[worker] Drive file updated (MP4, fully seekable)`);
  } catch (err) {
    console.warn(`[worker] FFmpeg remux skipped (${err.message}) — using original`);
  }

  // ── Step 2: Upload to AssemblyAI (get a hosted URL) ───────────────────────
  await job.updateProgress(25);
  console.log(`[worker] Uploading to AssemblyAI…`);

  const assemblyUrl = await uploadAudio(audioBuffer);
  console.log(`[worker] AssemblyAI upload URL received`);

  // ── Step 3: Submit for transcription ──────────────────────────────────────
  await job.updateProgress(35);
  const transcriptId = await submitTranscription(assemblyUrl);
  console.log(`[worker] Transcription submitted: ${transcriptId}`);

  // ── Step 4: Poll until complete ────────────────────────────────────────────
  await job.updateProgress(40);
  console.log(`[worker] Polling transcription…`);

  const { text, utterances } = await pollTranscription(transcriptId, (status) => {
    console.log(`[worker] Job ${jobId} — transcription status: ${status}`);
  });

  console.log(`[worker] Transcription complete — ${text.length} chars, ${utterances.length} utterances`);

  // ── Step 5: Create Google Doc with transcript ─────────────────────────────
  await job.updateProgress(80);
  const title = `Transcript — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const driveUrl = `https://drive.google.com/file/d/${driveFileId}/view`;

  const { docId, docUrl } = await createTranscriptDoc(
    title,
    new Date().toISOString(),
    driveUrl,
    text,
    utterances,
    accessToken,
  );
  console.log(`[worker] Google Doc created: ${docUrl}`);

  // ── Step 6: Send completion email ─────────────────────────────────────────
  const recipient = userEmail || process.env.NOTIFY_EMAIL;
  if (recipient) {
    await sendCompletionEmail(recipient, driveUrl, docUrl, new Date().toISOString());
    console.log(`[worker] Email sent to ${recipient}`);
  } else {
    console.warn(`[worker] No recipient email — set NOTIFY_EMAIL in .env`);
  }

  await job.updateProgress(100);

  return { status: 'completed', jobId, transcriptId, charCount: text.length, docId, docUrl };
}, {
  connection,
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
  console.error('[worker] Worker error:', err);
});
