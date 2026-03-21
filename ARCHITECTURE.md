# System Architecture — Chrome Tab Recorder

## Overview

The system is split into two parts: a **Chrome Extension** (Manifest v3) that handles recording, local persistence, and Google Drive upload, and a **Node.js backend** that handles the transcription pipeline, Google Doc creation, and email notification. They communicate over HTTP, with the backend running a BullMQ queue backed by Redis.

```
┌─────────────────────────────────────────────────┐
│                Chrome Extension                  │
│                                                  │
│  popup.js ──► background.js (service worker)     │
│                    │                             │
│                    ├─► offscreen.js              │
│                    │    └─ MediaRecorder         │
│                    │    └─ IndexedDB chunks       │
│                    │                             │
│                    ├─► utils/upload.js           │
│                    │    └─ Drive resumable upload │
│                    │                             │
│                    └─► POST /jobs (backend)      │
└─────────────────────────────────────────────────┘
                          │
                    HTTP / BullMQ
                          │
┌─────────────────────────────────────────────────┐
│                Node.js Backend                   │
│                                                  │
│  Express ──► BullMQ Queue ──► Worker             │
│                                │                 │
│                                ├─ Drive download  │
│                                ├─ FFmpeg remux    │
│                                ├─ AssemblyAI      │
│                                ├─ Google Docs     │
│                                └─ Resend email    │
└─────────────────────────────────────────────────┘
```

---

## Chrome Extension Architecture

### Manifest v3 constraints

MV3 service workers have no persistent memory — they can be killed by Chrome at any time and restarted on demand. This shapes every design decision in the extension:

- **No in-memory state.** All job data, upload progress, and session URIs are stored in `chrome.storage.local`.
- **No long-running async chains in the service worker.** The offscreen document handles the blocking MediaRecorder work; the service worker only coordinates.
- **`chrome.alarms`** is used for periodic backend polling instead of `setInterval`, which does not survive service worker restarts.

### Tab recording (`offscreen.js`)

Chrome MV3 prohibits `getUserMedia` in service workers. Recording runs in a hidden **offscreen document** which has access to web APIs.

The flow:
1. `background.js` calls `chrome.tabCapture.getMediaStreamId()` to get a stream ID for the active tab.
2. The offscreen document is created (or reused if it already exists).
3. `offscreen.js` calls `getUserMedia` with the stream ID, mixes in the microphone via Web Audio API, and starts `MediaRecorder`.

Codec selection prefers H.264 (hardware-accelerated via Apple VideoToolbox on macOS, NVENC on Windows) to minimise CPU usage. VP8 is the fallback.

Settings: 2560×1440, 24fps, 1 Mbps video bitrate.

### Chunk streaming to IndexedDB

`MediaRecorder` runs with a 1-second timeslice. Each `ondataavailable` event writes one chunk to IndexedDB immediately and fire-and-forgets. This keeps heap memory flat regardless of recording length — a 2-hour recording produces ~7,200 1-second chunks in IndexedDB rather than one large in-memory blob.

On stop, chunks are read back in order, assembled into a single `Blob`, and saved to the `recordings` store. The chunks are then deleted.

### Local persistence strategy

Two IndexedDB stores:
- `recordings` — final assembled blobs (`{ id, blob, savedAt }`)
- `chunks` — in-flight 1-second segments (`{ recordingId, index, data }`)

Job metadata (status, upload progress, session URI, Drive file ID, doc URL) lives in `chrome.storage.local` as a JSON array under the key `jobs`. This is intentionally separate from the blob storage so job state survives even if IndexedDB is cleared.

---

## Upload Retry Logic

### Resumable uploads

All Drive uploads use the [Google Drive resumable upload API](https://developers.google.com/drive/api/guides/manage-uploads#resumable). The session URI is stored in `chrome.storage.local` alongside the job. If the upload is interrupted:

1. On the next attempt (automatic retry or browser restart), the session URI is reused.
2. A `PUT` with `Content-Range: bytes */{total}` is issued to query the resume offset.
3. Upload resumes from the last confirmed byte.

This makes uploads resilient to browser restarts, network drops, and sleep/wake cycles.

### Retry schedule

Upload failures are retried up to 5 times with exponential backoff (base 30 seconds). After 5 failures the job moves to `failed` and a Chrome notification is shown. The user can manually retry from the popup, which restarts the upload from the last valid session.

---

## Duplicate Job Prevention

Jobs are keyed by a UUID generated at recording stop time. This ID is used as:
- The IndexedDB recording key
- The `chrome.storage.local` job ID
- The BullMQ job ID (`jobId` option)

BullMQ deduplicates by job ID — submitting the same ID twice is a no-op. This makes the `POST /jobs` call from the extension idempotent: if the backend acknowledgement is lost and the extension retries, no duplicate transcription job is created.

---

## Backend Queue Architecture

### Why BullMQ + Redis

BullMQ was chosen over Google Cloud Tasks / Pub/Sub because:
- Zero infrastructure cost for local dev and demo
- Built-in retry with exponential backoff
- Job state queryable via `GET /jobs/:id` (polled by the extension)
- Visual dashboard (`/admin`) for debugging

The same architecture could be swapped for Cloud Tasks with minimal changes to the worker.

### Worker pipeline

```
1. Download recording from Google Drive (streaming, not buffered)
2. FFmpeg remux: WebM → MP4 (-c:v copy -c:a aac)
   - Adds Duration element and seek index (Cues)
   - Replaces Drive file content in-place, renames to .mp4
3. Upload raw audio/video buffer to AssemblyAI (hosted URL)
4. Submit transcription job (speaker_labels: true, speech_models: universal-2)
5. Poll AssemblyAI every 5 seconds until complete
6. Create Google Doc (title, date, Drive link, full transcript with speaker labels)
7. Send completion email via Resend (Drive link + Doc link)
8. Return { transcriptId, docId, docUrl } as job return value
```

Each step is sequential within the worker. BullMQ retries the entire job up to 3 times with exponential backoff if any step throws.

---

## Transcription Orchestration

AssemblyAI is used for speech-to-text with the `universal-2` model and `speaker_labels: true`.

The audio file is first uploaded to AssemblyAI's hosted storage via `POST /upload` (returns a URL). The transcription request references this URL — AssemblyAI pulls and processes the file server-side, avoiding large payloads in the polling response.

Polling runs every 5 seconds until `status` is `completed` or `error`. For a 2-hour recording at typical speech density, processing takes 5–15 minutes.

For very long recordings, AssemblyAI handles segmentation internally. No client-side chunking is required.

---

## Google Doc Generation

The transcript doc is created via the Google Docs API with:
- **Title**: `Recording — {date}`
- **Body**: formatted date, link to the Drive recording, full transcript text
- **Speaker diarization**: if speaker labels are present, each segment is prefixed with `Speaker A:`, `Speaker B:`, etc.

The doc is created in the authenticated user's Drive (same OAuth token used for the Drive upload).

---

## Email Notification Pipeline

Email is sent via [Resend](https://resend.com) after the Google Doc is created. The recipient is determined in order:
1. `job.userEmail` — captured from `chrome.identity.getProfileUserInfo()` at recording stop time
2. `NOTIFY_EMAIL` env var — fallback for accounts without a verified Resend domain

The email contains links to the Drive recording and the transcript Doc.

Optional failure notifications are sent as Chrome notifications (via `chrome.notifications`) when a job fails, prompting the user to retry from the popup.

---

## Large File Handling

| Concern | Solution |
|---|---|
| RAM during recording | 1-second chunks streamed to IndexedDB; heap stays flat |
| Upload size | Google Drive resumable upload; no size limit |
| Upload interruption | Session URI persisted; resumes from last byte |
| FFmpeg memory | Stream-copy (`-c:v copy`); no re-encode; I/O bound not CPU bound |
| Transcription length | AssemblyAI handles multi-hour files natively |
| Worker timeout | BullMQ job has no default timeout; polling loop runs until AssemblyAI responds |

### Large recording validation

A 15-minute 1440p recording was used as the primary stress test:
- Memory usage observed flat throughout (chunks written to IndexedDB, not RAM)
- Upload interrupted mid-way by closing Chrome; reopening resumed from the correct byte offset
- FFmpeg remux completed in under 10 seconds (stream-copy, not re-encode)
- AssemblyAI transcription returned in ~3 minutes

For a 2-hour recording, all bottlenecks scale linearly with the above observations. The only expected increase is AssemblyAI processing time (~15–30 minutes), which the polling loop handles transparently.

---

## Scaling Considerations

- **Multiple workers**: BullMQ supports concurrent workers. Running `N` worker processes processes `N` jobs in parallel. Redis is the coordination point.
- **Backend statelessness**: the Node.js server holds no in-memory state; any number of instances can share the same Redis.
- **Drive quota**: the extension uses `drive.file` scope (access only to files it created), keeping the OAuth footprint minimal. Large uploads count against the user's Drive quota, not a service account.
- **AssemblyAI rate limits**: the free tier allows ~5 concurrent transcriptions. For higher throughput, the BullMQ concurrency setting should be adjusted to match the account's limit.
