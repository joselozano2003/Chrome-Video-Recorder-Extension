// backend/src/routes/jobs.js — POST /jobs  &  GET /jobs/:jobId

import { Router } from 'express';
import { transcriptionQueue } from '../workers/transcription.js';

const router = Router();

// ─── POST /jobs ────────────────────────────────────────────────────────────────
// Called by the extension after a successful Drive upload.
// Enqueues a transcription job in BullMQ.
router.post('/', async (req, res) => {
  const { jobId, driveFileId, userEmail, accessToken } = req.body;

  if (!jobId || !driveFileId) {
    return res.status(400).json({ error: 'jobId and driveFileId are required' });
  }

  try {
    await transcriptionQueue.add(
      'transcribe',
      { jobId, driveFileId, userEmail: userEmail || '', accessToken },
      {
        jobId,           // use extension jobId so idempotent re-queues are safe
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      }
    );

    console.log(`[jobs] Queued transcription job: ${jobId}`);
    return res.status(202).json({ queued: true, jobId });
  } catch (err) {
    // BullMQ throws if a job with the same ID already exists — that's fine
    if (err.message?.includes('already exists')) {
      return res.status(202).json({ queued: true, jobId, note: 'already queued' });
    }
    console.error('[jobs] Failed to enqueue job:', err);
    return res.status(500).json({ error: 'Failed to queue job' });
  }
});

// ─── GET /jobs/:jobId ──────────────────────────────────────────────────────────
// Polled by the extension to get backend job state.
router.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await transcriptionQueue.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const state = await job.getState();
    return res.json({
      jobId:       job.id,
      state,
      progress:    job.progress,
      returnValue: job.returnvalue,
      failReason:  job.failedReason,
    });
  } catch (err) {
    console.error('[jobs] Error fetching job:', err);
    return res.status(500).json({ error: 'Failed to fetch job' });
  }
});

export default router;
