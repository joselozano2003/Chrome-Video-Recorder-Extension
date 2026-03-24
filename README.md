# Chrome Tab Recorder

A Chrome extension that records browser tabs, automatically uploads recordings to Google Drive, transcribes audio with AssemblyAI, generates a Google Doc transcript, and sends an email notification — all with a durable, retry-safe job queue.

---

## Features

- Record any browser tab (video + system audio + microphone, or audio-only)
- Chunked recording streamed to IndexedDB — flat memory usage for long recordings
- Resumable Google Drive upload with automatic retry on failure
- Recordings organised into per-session folders inside a root **Tab Recordings** Drive folder
- Backend transcription pipeline: AssemblyAI → Google Doc
- Email notification with links to the recording and transcript
- Job queue visible in the extension popup with live status updates
- **Server-offline resilience**: if the backend is unreachable after a Drive upload, the popup shows the error and automatically retries every minute via `chrome.alarms` — no recordings are lost

---

## Architecture Overview

```
Chrome Extension                           Backend (Node.js)
────────────────                           ─────────────────
offscreen.js                               BullMQ Worker
  └─ MediaRecorder (H.264/VP8, 1440p)        └─ Download from Drive
  └─ 1s chunks → IndexedDB                   └─ AssemblyAI transcription (WebM/Opus)
  └─ Assemble blob on stop                   └─ Create Google Doc
                                             └─ Create Google Doc
background.js  (service worker)             └─ Send email (Resend)
  └─ Google OAuth (chrome.identity)
  └─ Resumable Drive upload              Redis
  └─ POST /jobs → backend              Redis
  └─ chrome.alarms → poll every 1 min    └─ BullMQ job persistence
  └─ chrome.alarms → poll every 1 min

popup.js
  └─ Renders jobs from storage (2s)
  └─ Polls backend via message (5s)
  └─ Recording timer + retry buttons
```

### Key design decisions

**Large recording support**
MediaRecorder runs with a 1-second timeslice. Each chunk is written to IndexedDB immediately, keeping RAM usage flat regardless of recording length. The final blob is assembled on stop before upload.

**Resumable uploads**
Google Drive resumable upload sessions are persisted to `chrome.storage.local`. If the browser is closed mid-upload, the session URI is reused and the upload resumes from the last confirmed byte on next startup.

**Idempotency**
BullMQ jobs are keyed by the extension's job ID. Re-queuing the same job is a no-op. Drive uploads check the resumable session before starting a new one.

**Service worker resilience**
MV3 service workers can be killed at any time. All state (jobs, upload progress, session URIs) lives in `chrome.storage.local`, never in memory. On `onStartup` and `onInstalled`, pending jobs are automatically resumed.

**Server-offline retry**
`notifyBackend` does not use `setTimeout` (which is killed when the service worker suspends). Instead, failed notifications leave the job in `uploaded` state and a `retryUploadedJobs` call runs on every `poll-backend` alarm tick (every 1 minute). The popup surfaces the error so the user can also trigger a manual retry.

**Concurrent recording protection**
A `recordingInProgress` flag in `chrome.storage.local` acts as a mutex. A second start attempt is rejected immediately, preventing state corruption from double-clicks or rapid popup re-opens.

**Offscreen zombie recovery**
`ensureOffscreen` always force-closes any existing offscreen document before creating a new one. This recovers from stale offscreen instances left behind by a crashed previous session.

---

## Prerequisites

- Node.js 20+
- Docker (for Redis)
- Chrome 116+

---

## Quick Start

### 1. Clone the repo

```bash
git clone <repo-url>
cd Recorder
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and fill in all values (see [API Keys](#api-keys) below).

### 3. Start everything with Docker

```bash
cd backend
docker compose up --build
```

This starts both Redis and the backend. The server is available at `http://localhost:3000`.
BullMQ dashboard: `http://localhost:3000/admin` (default credentials: `admin` / `admin` — override with `ADMIN_USER` / `ADMIN_PASS` env vars)

> **For local development** (hot reload): run Redis only via `docker compose up redis`, then `npm install && npm run dev` in a separate terminal.

### 4. Install the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 5. Authorize Google

On first use the extension will prompt for Google OAuth. Grant access to Google Drive and Google Docs.

---

## GitHub Codespaces

This repository includes a Dev Container configuration. Open it in Codespaces and the environment (Node.js 20 + Redis) will be provisioned automatically.

### 1. Start Redis and the backend

```bash
cd backend
docker compose up redis -d
npm install && npm run dev
```

### 2. Make port 3000 public

In the Codespaces **Ports** tab, right-click port `3000` → **Port Visibility** → **Public**.

Copy the forwarded URL — it looks like:
```
https://your-codespace-3000.app.github.dev
```

### 3. Point the extension at Codespaces

In `extension/config.js`, replace the `BACKEND_URL`:

```js
export const BACKEND_URL = 'https://your-codespace-3000.app.github.dev';
```

> Make sure there is **no trailing slash** at the end of the URL.

### 4. Reload the extension

Go to `chrome://extensions` → click **Reload** on Chrome Tab Recorder.

The extension will now send jobs to the Codespaces backend. Note that the forwarded URL changes each time you create a new Codespace, so you'll need to update `BACKEND_URL` again if you recreate it.

---

## API Keys

### AssemblyAI
1. Sign up at [assemblyai.com](https://www.assemblyai.com)
2. Copy your API key from the dashboard
3. Set `ASSEMBLYAI_API_KEY` in `.env`

### Google OAuth (Drive + Docs)
1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Chrome Extension type)
3. Enable **Google Drive API** and **Google Docs API**
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`
5. Update the `oauth2.client_id` field in `extension/manifest.json` with your client ID

### Resend (email)
1. Sign up at [resend.com](https://resend.com)
2. Create an API key
3. Set `RESEND_API_KEY` in `.env`
4. Set `NOTIFY_EMAIL` to your Resend-registered email (required until you verify a custom domain)

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in the values. See [`backend/README.md`](./backend/README.md#environment-variables) for the full reference including production/Upstash-specific variables.

---

## Project Structure

```
Recorder/
├── extension/               # Chrome Extension (Manifest v3)
│   ├── background.js        # Service worker: OAuth, Drive upload, job queue
│   ├── offscreen.js         # MediaRecorder in hidden offscreen document
│   ├── popup/               # Extension popup UI
│   ├── utils/
│   │   ├── db.js            # IndexedDB: chunk streaming + blob assembly
│   │   ├── queue.js         # Job queue (chrome.storage.local)
│   │   └── upload.js        # Resumable Google Drive upload
│   └── manifest.json
│
└── backend/                 # Node.js backend
    ├── src/
    │   ├── server.js        # Express entry point + BullMQ dashboard
    │   ├── routes/jobs.js   # POST /jobs, GET /jobs/:id
    │   ├── workers/
    │   │   └── transcription.js  # BullMQ worker: AssemblyAI, Docs, email
    │   └── services/
    │       ├── assemblyai.js     # Upload + poll transcription
    │       ├── googledocs.js     # Create transcript Google Doc
    │       └── email.js          # Send completion email via Resend
    ├── docker-compose.yml   # Redis
    └── .env.example
```

---

## Recording Settings

| Setting | Value |
|---|---|
| Resolution | Up to 2560×1440 |
| Frame rate | Up to 24 fps |
| Video bitrate | 1 Mbps |
| Video codec | H.264 (hardware-accelerated), VP8 fallback |
| Audio codec | Opus |
| Output format | WebM (stored as-is in Drive; natively supported by AssemblyAI) |

---

## Large Recording Validation

Validated with a **2-hour 1440p recording**:

| Concern | Result |
|---|---|
| Memory during recording | Heap stayed flat — ~7,200 chunks written to IndexedDB, not RAM |
| Upload interrupted | Closed Chrome mid-upload; reopened and resumed from the exact byte offset |
| AssemblyAI transcription | Returned in ~18 minutes |
| End-to-end | Recording stop → email received in ~20 minutes |

To test upload resilience: record a session, kill the browser mid-upload, reopen Chrome, and verify the upload resumes automatically.

To test server-offline resilience: stop the backend after a Drive upload completes. The popup will show "Server unreachable — retrying automatically" on the job card. Restart the backend and within one minute the job moves to `queued` without any user action.
