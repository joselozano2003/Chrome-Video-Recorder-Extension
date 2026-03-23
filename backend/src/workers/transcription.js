// backend/src/workers/transcription.js — BullMQ queue + worker

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { execFile } from 'child_process';
import { createWriteStream, statSync } from 'fs';
import { unlink, readFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { uploadAudioFile, submitTranscription, pollTranscription } from '../services/assemblyai.js';
import { createTranscriptDoc } from '../services/googledocs.js';
import { sendCompletionEmail } from '../services/email.js';

/**
 * Stream a fetch Response body to a file on disk.
 * Avoids loading the entire file into memory.
 */
async function streamToDisk(response, destPath) {
  await pipeline(response.body, createWriteStream(destPath));
}

/**
 * Single FFmpeg pass: WebM input → MP4 (full video) + audio-only AAC.
 * Both outputs are written to disk — no large buffers in memory.
 * Returns { mp4Path, audioPath }.
 */
async function remuxAndExtract(inputPath) {
  const id        = Date.now();
  const mp4Path   = join(tmpdir(), `rec-${id}.mp4`);
  const audioPath = join(tmpdir(), `rec-${id}.aac`);

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      // Output 1: full MP4 — copy video track, transcode Opus → AAC
      '-c:v', 'copy', '-c:a', 'aac', mp4Path,
      // Output 2: audio only — for AssemblyAI (much smaller than full video)
      '-vn', '-c:a', 'aac', '-b:a', '128k', audioPath,
    ], { stdio: 'pipe' }, (err) => err ? reject(err) : resolve());
  });

  return { mp4Path, audioPath };
}

/**
 * Resumable upload to Google Drive — required for files larger than 5 MB.
 * Uploads in 10 MB chunks so memory usage stays flat regardless of file size.
 */
async function resumableUploadToDrive(fileId, filePath, mimeType, accessToken) {
  const fileSize = statSync(filePath).size;
  const CHUNK    = 10 * 1024 * 1024; // 10 MB

  // Step 1: initiate the resumable session
  const initRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': fileSize,
      },
      body: JSON.stringify({}),
    }
  );

  if (!initRes.ok) {
    throw new Error(`Drive resumable init failed: ${initRes.status} ${await initRes.text()}`);
  }

  const uploadUri = initRes.headers.get('location');

  // Step 2: upload chunks
  const { createReadStream } = await import('fs');
  let offset = 0;

  while (offset < fileSize) {
    const end    = Math.min(offset + CHUNK - 1, fileSize - 1);
    const length = end - offset + 1;

    // Read just this chunk into memory
    const chunk = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = createReadStream(filePath, { start: offset, end });
      stream.on('data', (d) => chunks.push(d));
      stream.on('end',  () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    const chunkRes = await fetch(uploadUri, {
      method: 'PUT',
      headers: {
        'Content-Length': length,
        'Content-Range': `bytes ${offset}-${end}/${fileSize}`,
        'Content-Type': mimeType,
      },
      body: chunk,
    });

    // 200/201 = done, 308 = continue
    if (!chunkRes.ok && chunkRes.status !== 308) {
      throw new Error(`Drive chunk upload failed at offset ${offset}: ${chunkRes.status}`);
    }

    offset = end + 1;
  }
}

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

  const id        = Date.now();
  const inputPath = join(tmpdir(), `rec-${id}-in.webm`);
  let   mp4Path   = null;
  let   audioPath = null;

  try {
    // ── Step 1: Stream file from Google Drive to disk (no RAM buffer) ──────────
    await progress(job, 10);
    console.log(`[worker] Downloading from Drive…`);

    const driveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!driveRes.ok) {
      throw new Error(`Drive download failed: ${driveRes.status} ${await driveRes.text()}`);
    }

    await streamToDisk(driveRes, inputPath);
    const inputMB = (statSync(inputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[worker] Downloaded ${inputMB} MB to disk`);

    // ── Step 1b: FFmpeg — produce MP4 (for Drive) + audio-only (for AssemblyAI) ─
    await progress(job, 20);
    let seekable = false;

    try {
      ({ mp4Path, audioPath } = await remuxAndExtract(inputPath));
      const mp4MB   = (statSync(mp4Path).size   / 1024 / 1024).toFixed(1);
      const audioMB = (statSync(audioPath).size / 1024 / 1024).toFixed(1);
      console.log(`[worker] FFmpeg done — MP4: ${mp4MB} MB, audio: ${audioMB} MB`);

      // Replace the WebM on Drive with the seekable MP4 (resumable upload)
      await resumableUploadToDrive(driveFileId, mp4Path, 'video/mp4', accessToken);

      // Rename the Drive file to .mp4
      const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (metaRes.ok) {
        const { name } = await metaRes.json();
        await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.replace(/\.webm$/i, '.mp4') }),
        });
      }

      seekable = true;
      console.log(`[worker] Drive file updated (MP4, fully seekable)`);
    } catch (err) {
      console.warn(`[worker] FFmpeg/Drive update failed (${err.message}) — will transcribe original WebM`);
    }

    // ── Step 2: Upload audio to AssemblyAI ────────────────────────────────────
    await progress(job, 35);
    console.log(`[worker] Uploading audio to AssemblyAI…`);

    // Use audio-only file if FFmpeg succeeded, otherwise fall back to the raw WebM
    const assemblyUrl = await uploadAudioFile(audioPath ?? inputPath);
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

    return { status: 'completed', jobId, transcriptId, charCount: text.length, docId, docUrl, seekable };

  } finally {
    // Always clean up temp files regardless of success or failure
    await Promise.allSettled([
      unlink(inputPath).catch(() => {}),
      mp4Path   ? unlink(mp4Path).catch(() => {})   : Promise.resolve(),
      audioPath ? unlink(audioPath).catch(() => {}) : Promise.resolve(),
    ]);
  }
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
