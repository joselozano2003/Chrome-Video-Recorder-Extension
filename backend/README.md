# Recorder Backend

Node.js/Express backend for the Recorder Chrome extension. Receives transcription jobs from the extension, processes them through a BullMQ queue, and delivers results via Google Docs + email.

## What it does

1. Extension uploads a WebM recording to Google Drive, then POSTs a job to `POST /jobs`.
2. The server enqueues the job in BullMQ (backed by Redis/Upstash in production).
3. The worker:
   - Downloads the WebM from Google Drive
   - Uploads it directly to AssemblyAI and polls until the transcript is ready
   - Creates a Google Doc in the user's Drive session folder
   - Sends a completion email via Resend
4. The extension polls `GET /jobs/:jobId` to track progress.

**Stack:** Express 5, BullMQ 5, ioredis, AssemblyAI, Resend
**Runtime:** Node 20, ESM modules (`"type": "module"`)

### Recording format

The extension records in WebM (the only format the browser's MediaRecorder API can produce). The backend uploads WebM directly to AssemblyAI, which natively supports WebM/Opus — no conversion step. The WebM file is also stored as-is in Google Drive.

---

## Local Development

See the root [`README.md`](../README.md#quick-start) for the full quick start. Backend-specific notes:

- **Hot reload**: run Redis separately (`docker compose up redis -d`), then `npm run dev` in a separate terminal.
- **All-in-one**: `docker compose up --build` starts both Redis and the backend.
- Server: `http://localhost:3000` · Dashboard: `http://localhost:3000/admin` · Health: `http://localhost:3000/health`
- Leave `REDIS_HOST=localhost`, `REDIS_PORT=6379`, and unset `REDIS_PASSWORD`/`REDIS_TLS` for local dev.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/jobs` | Enqueue a transcription job. Body: `{ jobId, driveFileId, sessionFolderId, userEmail, createdAt, timeZone, accessToken }`. Returns `202 { queued: true, jobId }`. |
| `GET` | `/jobs/:jobId` | Poll job state. Returns `{ jobId, state, progress, returnValue, failReason }`. |
| `GET` | `/health` | Health check. Returns `{ status: "ok" }`. |
| `GET` | `/admin` | BullMQ dashboard (basic auth required). |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_HOST` | Yes | Hostname only — no `https://` prefix. Local: `localhost`. Upstash: e.g. `frank-gnat-82644.upstash.io`. |
| `REDIS_PORT` | Yes | Redis port. Usually `6379`. |
| `REDIS_PASSWORD` | Upstash only | Redis password. Leave unset for local dev. |
| `REDIS_TLS` | Upstash only | Set to `true` for Upstash. Leave unset for local dev. |
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 client ID from Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 client secret. |
| `GOOGLE_REDIRECT_URI` | Yes | Must match authorized redirect URI in Google Cloud Console. Local: `http://localhost:3000/auth/callback`. Production: `https://recorder-backend-409823534577.us-central1.run.app/auth/callback`. |
| `ASSEMBLYAI_API_KEY` | Yes | AssemblyAI API key. |
| `RESEND_API_KEY` | Yes | Resend API key. |
| `FROM_EMAIL` | No | Sender address for completion emails. |
| `NOTIFY_EMAIL` | Yes | Fallback recipient when the job has no `userEmail`. |
| `ADMIN_USER` | No | BullMQ dashboard username. Default: `admin`. |
| `ADMIN_PASS` | No | BullMQ dashboard password. Default: `admin`. Change in production. |
| `PORT` | **Never set manually** | Cloud Run injects this automatically. Do not add it as a Cloud Run env var. |

---

## GCP Deployment

### Infrastructure

| Setting | Value |
|---------|-------|
| GCP Project | `video-recorder-chrome` |
| Cloud Run service | `recorder-backend` |
| Region | `us-central1` |
| Artifact Registry repo | `recorder-backend` |
| Image | `us-central1-docker.pkg.dev/video-recorder-chrome/recorder-backend/app:latest` |
| Live URL | `https://recorder-backend-409823534577.us-central1.run.app` |
| Min instances | 0 (scales to zero when idle, ~1–2s cold start) |
| Max instances | 2 |
| Memory | 1Gi |

### Redis in production — Upstash

Cloud Run runs one container per instance. Running Redis inside the container means each instance has isolated, ephemeral state — queue data would be lost on restart or scale-out. Instead, production uses **Upstash** (free tier: 10K commands/day, no credit card required).

Upstash requires TLS (`REDIS_TLS=true`) and password auth (`REDIS_PASSWORD`). It also force-closes idle TCP connections after ~60 seconds — this is expected and handled in the code (see Troubleshooting).

### First-time setup checklist

1. Enable APIs: Cloud Run, Cloud Build, Artifact Registry.
2. Grant the Cloud Build service account `roles/storage.admin` and `roles/artifactregistry.writer`.
3. Create an Artifact Registry Docker repo named `recorder-backend` in `us-central1`.
4. Create an Upstash Redis database and copy the host, port, and password.
5. Set all required env vars on the Cloud Run service.

---

## Redeployment

Run from the `backend/` directory. Run each command as a single line — avoid multiline backslash-continued commands in zsh interactive terminals.

**Build and push:**
```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/video-recorder-chrome/recorder-backend/app:latest .
```

**Deploy:**
```bash
gcloud run deploy recorder-backend --image us-central1-docker.pkg.dev/video-recorder-chrome/recorder-backend/app:latest --region us-central1 --platform managed
```

---

## Viewing Logs

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=recorder-backend" --limit=50 --format="value(timestamp,textPayload)" --freshness=5m
```

---

## Troubleshooting

### `ECONNRESET` / `EPIPE` in logs

Upstash free tier kills idle TCP connections after ~60s. BullMQ's worker holds a blocking Redis connection while waiting for jobs, and Upstash closes it when the queue is quiet. This is expected — ioredis reconnects automatically via `retryStrategy`. The code suppresses these transient error codes so they don't flood logs.

### Jobs fail mid-run due to Redis blip

`job.updateProgress()` calls are non-fatal (`.catch(() => {})`). A Redis disconnect during job processing will not kill the job — only an unhandled error in the worker logic will.

### `REDIS_HOST` connection error

`REDIS_HOST` must be the bare hostname — no `https://` prefix.
Correct: `frank-gnat-82644.upstash.io`
Wrong: `https://frank-gnat-82644.upstash.io`

### Cloud Build permission error

The Cloud Build service account needs both `roles/storage.admin` (for the build cache bucket) and `roles/artifactregistry.writer` (to push the image). Grant both in IAM & Admin → IAM in Google Cloud Console.

### `PORT` env var conflict

Do not set `PORT` as a Cloud Run environment variable — Cloud Run reserves it and will reject the deployment.

### BullMQ dashboard shows no queues

The dashboard requires HTTP Basic Auth. Default credentials: `admin` / `admin`. Set `ADMIN_USER` and `ADMIN_PASS` to override.

### Failed job not re-queuing

`POST /jobs` detects jobs in `failed` state, removes them, and re-queues automatically. Jobs in `waiting`, `active`, or `completed` state are not duplicated.
