# Demo Script — Chrome Tab Recorder

> Present as if showing the product to a non-technical user.
> Estimated recording time: 8–12 minutes.

---

## Setup (before hitting record on your screen recorder)

- [ ] Backend running: `cd backend && docker compose up redis -d && npm run dev`
- [ ] Extension loaded at `chrome://extensions` (Developer mode ON, loaded unpacked from `extension/`)
- [ ] A tab ready to record (e.g. a YouTube video or any page with audio)
- [ ] Gmail or inbox open in another tab (for the email notification at the end)
- [ ] Google Drive open in another tab (to show the folder structure at the end)

---

## 1. Installing the Extension

**Show:**
1. Open `chrome://extensions`
2. Toggle **Developer mode** ON (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. The Chrome Tab Recorder icon appears in the toolbar

**Say:**
> "Installing the extension is a one-step process — load it from the project folder and it's ready to use."

---

## 2. Recording a Browser Tab

**Show:**
1. Navigate to the tab you want to record (e.g. a YouTube video, start playing it)
2. Click the Chrome Tab Recorder extension icon
3. Point out the default toggles:
   - **System audio** — ON
   - **Microphone** — ON
   - **Audio only** — OFF (we're doing video + audio)
4. Click **Record**
5. If prompted for microphone permission, grant it
6. The red pulsing dot appears, status shows **Recording…**, and the timer starts counting up

**Say:**
> "By default the extension captures both system audio and your microphone — so everything happening in the tab plus your voice commentary is recorded. You can disable either before starting."

---

## 3. Recording in Progress

**Show:**
1. Let the recording run for 1–2 minutes (enough to get a meaningful transcript)
2. Point to the timer showing elapsed time
3. While recording, show that the tab continues playing normally — audio isn't interrupted

**Say:**
> "The timer shows how long you've been recording. The tab continues working normally — audio keeps playing, video keeps streaming. Everything is being captured in the background."

---

## 4. Stopping the Recording

**Show:**
1. Click **Stop**
2. Status briefly shows **Stopping…** then **Saved locally. Starting upload…**
3. In the job queue below, a new job card appears with status **Uploading** and a progress bar

**Say:**
> "When you stop, the recording is saved locally first — before anything is sent anywhere. Then the upload to Google Drive begins automatically."

---

## 5. Viewing the Job Queue

**Show:**
1. Point to the job card — show the short ID, timestamp, and **Uploading** badge
2. Watch the progress bar fill up
3. Status transitions: **Uploading** → **Uploaded** → **Queued** → **Transcribing**

**Say:**
> "The job queue gives you full visibility into what's happening. Upload progress is shown in real time. Once the file reaches Google Drive, it's queued for transcription automatically — no manual steps needed."

---

## 6. Demonstrating Retry Behavior

> Two scenarios to demonstrate — run whichever fits best live or pre-record both.

### Scenario A — Drive upload interrupted (browser closed mid-upload)

**Show:**
1. Start a new short recording (10–15 seconds), then stop it
2. As soon as the progress bar starts moving, close Chrome entirely
3. Reopen Chrome, open the extension
4. Show the job is still there — status **Uploading**, progress bar where it left off
5. Within a few seconds the upload resumes and completes automatically

**Say:**
> "Even closing the browser entirely doesn't lose the recording. The upload session is persisted to local storage and resumes from the exact byte it left off."

### Scenario B — Backend server offline (Drive upload succeeded, server unreachable)

**Show:**
1. Stop the backend: `Ctrl+C` in the terminal
2. Make a short recording and stop it
3. The Drive upload completes (progress bar fills, badge goes to **Uploaded**)
4. On the job card, the error appears: *"Server unreachable — retrying automatically"* with a **Notify server** button
5. Restart the backend: `npm run dev`
6. Within one minute (no user action), the job moves to **Queued** automatically
7. Optionally: click **Notify server** to trigger it immediately without waiting

**Say:**
> "The recording is already safely on Google Drive. If the backend is temporarily down, the extension keeps retrying every minute in the background — no manual intervention needed. When the server comes back, the transcription kicks off automatically."

---

## 7. Backend Processing

**Show the backend terminal logs:**
```
[worker] Processing job abc123...
[worker] Downloaded 45.2 MB
[worker] Remuxed to MP4 — 43.1 MB
[worker] Uploading to AssemblyAI…
[worker] Transcription submitted: xyz789
[worker] Polling transcription…
[worker] Transcription complete — 3421 chars, 12 utterances
[worker] Google Doc created: https://docs.google.com/...
[worker] Email sent to you@example.com
```

**Say:**
> "On the backend, the recording is remuxed to MP4 for compatibility, then sent to AssemblyAI for transcription. Once the transcript is ready, a Google Doc is created automatically and an email is sent. All of this runs in a background queue — not a single synchronous request."

---

## 8. Job Completion

**Show:**
1. The job card in the extension updates to **Completed**
2. Two links appear: **Drive** and **Transcript**
3. A Chrome notification pops up: *"Recording ready — Your transcript and recording are available."*
4. Clicking the notification opens the Google Doc directly

**Say:**
> "The extension updates in real time. You get a Chrome notification the moment everything is ready, and clicking it takes you straight to the transcript."

---

## 9. Google Drive — Folder Structure

**Show:**
1. Open Google Drive
2. Navigate to **Tab Recordings** (root folder)
3. Open the session subfolder — e.g. `Recording — Mar 21, 2026, 3:45 PM`
4. Inside: the `.mp4` recording file and the transcript Google Doc, side by side

**Say:**
> "Every recording gets its own folder inside Tab Recordings — the video file and the transcript are kept together, making it easy to find everything from a given session."

---

## 10. Google Doc Transcript

**Show:**
1. Open the transcript Google Doc from the session folder
2. Point out:
   - Title: `Transcript — Mar 21, 2026`
   - Recording date and time
   - Link back to the Drive recording
   - Full transcript with speaker labels (e.g. `Speaker A [0:12]  Hello, welcome to...`)

**Say:**
> "The transcript is a clean, readable Google Doc with speaker separation. Each segment is timestamped so you can cross-reference with the recording. The link back to the video is right at the top."

---

## 11. Email Notification

**Show:**
1. Open your inbox
2. Show the email — subject: `Your recording transcript is ready — Mar 21, 2026`
3. Point out the two links: **View Transcript (Google Doc)** and **View Recording (Google Drive)**

**Say:**
> "You also get an email with direct links to both the recording and the transcript — so even if you're not looking at the extension, you'll know when it's ready."

---

## 12. Large Recording Handling

**Say (narrate over architecture diagram or terminal):**
> "The system was designed from the start to handle recordings up to two hours long. A few key decisions make this work:
>
> First, the recording is never held in memory — it's written to the browser's local storage one second at a time, so memory usage stays flat no matter how long you record.
>
> Second, uploads use Google Drive's resumable upload API, which means a two-hour recording can be interrupted halfway through and will pick up exactly where it left off — even after closing the browser.
>
> Third, transcription is handled by AssemblyAI, which processes long audio files natively — no chunking required on our end.
>
> We validated this with a 15-minute 1440p recording and simulated interruptions at different upload points. All bottlenecks — memory, upload, transcription — scale linearly with recording length."

---

## 13. Wrap Up

**Show the extension popup one more time:**
- Job history with completed jobs
- Links to Drive and Transcript on each card

**Say:**
> "Every recording you make is tracked here — with its status, links to the recording and transcript, and the ability to retry if anything goes wrong. The history survives browser restarts, so nothing is ever lost."

---

## Cuts / Editing Notes

- The retry section (step 6) can be pre-recorded separately and cut in — waiting for a real upload failure live is risky
- Backend terminal logs can be shown in a split screen during step 7
- Steps 9–11 can be shown quickly back-to-back — they're all "result" steps
- If transcription takes too long live, pre-record a completed job and cut to it
