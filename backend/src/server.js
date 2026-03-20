// backend/src/server.js — Express entry point

import 'dotenv/config';
import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter }   from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter }  from '@bull-board/express';

import { transcriptionQueue } from './workers/transcription.js';
import jobsRouter from './routes/jobs.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Allow requests from the Chrome extension
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── BullMQ Dashboard (/admin) ─────────────────────────────────────────────────
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin');

createBullBoard({
  queues:  [new BullMQAdapter(transcriptionQueue)],
  serverAdapter,
});

app.use('/admin', serverAdapter.getRouter());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/jobs', jobsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] BullMQ dashboard: http://localhost:${PORT}/admin`);
});
