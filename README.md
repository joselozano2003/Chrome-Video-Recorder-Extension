# Chrome Tab Recorder

A Chrome extension that records browser tabs, automatically uploads recordings to Google Drive, transcribes audio with AssemblyAI, generates a Google Doc transcript, and sends an email notification — all with a durable, retry-safe job queue.

---

## Features

- Record any browser tab (video + system audio + microphone, or audio-only)
- Chunked recording streamed to IndexedDB — flat memory usage for long recordings
- Resumable Google Drive upload with automatic retry on failure
- Backend transcription pipeline: FFmpeg remux → AssemblyAI → Google Doc
- Email notification with links to the recording and transcript
- Job queue visible in the extension popup with live status updates

---

## Architecture Overview

```
Chrome Extension                          Backend (Node.js)
─────────────────                         ─────────────────
offscreen.js                              BullMQ Worker
  └─ MediaRecorder (H.264/VP8, 1440p)       └─ Download from Drive
  └─ Chunks → IndexedDB                      └─ FFmpeg remux → MP4
  └─ Assembled on stop                       └─ Upload to AssemblyAI
                                             └─ Poll for transcript
background.js                               └─ Create Google Doc
  └─ Google OAuth (chrome.identity)          └─ Send email (Resend)
  └─ Resumable Drive upload
  └─ POST /jobs → BullMQ queue          Redis
  └─ Alarm polls /jobs/:id every 1 min    └─ BullMQ job persistence

popup.js
  └─ Live job queue (polls storage 2s)
  └─ Recording timer
  └─ Retry failed jobs
```

### Key design decisions

**Large recording support**
MediaRecorder runs with a 1-second timeslice. Each chunk is written to IndexedDB immediately, keeping RAM usage flat regardless of recording length. The final blob is assembled on stop before upload.

**Resumable uploads**
Google Drive resumable upload sessions are persisted to `chrome.storage.local`. If the browser is closed mid-upload, the session URI is reused and the upload resumes from the last confirmed byte on next startup.

**Seekable output**
Chrome's MediaRecorder omits the WebM Duration element. The backend remuxes the recording from WebM to MP4 using FFmpeg (`-c:v copy -c:a aac`), which adds a proper duration and seek index. The Drive file is replaced in-place and renamed to `.mp4`.

**Idempotency**
BullMQ jobs are keyed by the extension's job ID. Re-queuing the same job is a no-op. Drive uploads check the resumable session before starting a new one.

**Service worker resilience**
MV3 service workers can be killed at any time. All state (jobs, upload progress, session URIs) lives in `chrome.storage.local`, never in memory. On `onStartup` and `onInstalled`, pending jobs are automatically resumed.

---

## Prerequisites

- Node.js 20+
- Docker (for Redis)
- FFmpeg installed and on `PATH`
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
BullMQ dashboard: `http://localhost:3000/admin`

> **For local development** (hot reload): run Redis only via `docker compose up redis`, then `npm install && npm run dev` in a separate terminal.

### 4. Install the Chrome extension

### 5. Install the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 6. Authorize Google

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

In `extension/background.js`, replace the `BACKEND_URL`:

```js
const BACKEND_URL = 'https://your-codespace-3000.app.github.dev';
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

| Variable | Description |
|---|---|
| `PORT` | Backend port (default: `3000`) |
| `REDIS_HOST` | Redis host (default: `localhost`) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth redirect URI (default: `http://localhost:3000/auth/callback`) |
| `ASSEMBLYAI_API_KEY` | AssemblyAI API key |
| `RESEND_API_KEY` | Resend API key |
| `NOTIFY_EMAIL` | Fallback recipient email for notifications |

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
│   │   ├── upload.js        # Resumable Google Drive upload
│   │   └── fixWebmDuration.js  # WebM EBML duration patch (fallback)
│   └── manifest.json
│
└── backend/                 # Node.js backend
    ├── src/
    │   ├── server.js        # Express entry point + BullMQ dashboard
    │   ├── routes/jobs.js   # POST /jobs, GET /jobs/:id
    │   ├── workers/
    │   │   └── transcription.js  # BullMQ worker: FFmpeg, AssemblyAI, Docs, email
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
| Output format | MP4 (remuxed by backend FFmpeg) |

---

## Large Recording Validation

The system was designed around recordings up to 2 hours:

- **Memory**: 1-second chunks written to IndexedDB immediately; heap stays flat
- **Upload**: Google Drive resumable upload API; survives browser restart
- **Transcription**: AssemblyAI handles files up to several hours natively
- **FFmpeg**: Remux is stream-copy (`-c:v copy`), so processing time scales with I/O, not encoding

To stress test locally, record a 10–15 minute session, kill the browser mid-upload, reopen Chrome, and verify the upload resumes automatically.
