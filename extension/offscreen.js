// offscreen.js — runs in a hidden offscreen document
// ONLY responsible for: capturing the tab stream, running MediaRecorder, saving to IndexedDB.
// Job creation and upload are handled by background.js AFTER this document is done.

import { appendChunk, assembleAndSave } from './utils/db.js';

let mediaRecorder     = null;
let audioContext      = null;
let activeRecordingId = null;
let chunkIndex        = 0;
let pendingWrites     = [];
let recordingStartMs  = 0;

function pickMimeType(hasAudio, audioOnly = false) {
  if (audioOnly) {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';
  }
  // H.264 first — hardware-accelerated on macOS/Windows (lowest CPU)
  // VP8 fallback for platforms where H.264 isn't available
  const candidates = hasAudio
    ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=h264', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'offscreen-start':
      startRecording(message.streamId, message.options || {})
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'offscreen-stop':
      stopRecording()
        .then(result => sendResponse({ success: true, ...result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }
});

async function startRecording(streamId, options = {}) {
  if (mediaRecorder?.state === 'recording') throw new Error('Already recording');

  // Capture the tab (audio + video)
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth:  2560,
        maxHeight: 1440,
        maxFrameRate: 24,
      },
    },
  });

  const tabAudioTracks = tabStream.getAudioTracks();
  const videoTracks    = tabStream.getVideoTracks();
  console.log(`[offscreen] Tab stream — audio: ${tabAudioTracks.length}, video: ${videoTracks.length}`);

  // Build a mixed audio stream via Web Audio
  audioContext = new AudioContext();
  const mixDest = audioContext.createMediaStreamDestination();

  if (tabAudioTracks.length > 0) {
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    // Route tab audio back to speakers so the user can still hear it
    tabSource.connect(audioContext.destination);
    // Also send it to the recording mix
    if (options.systemAudio !== false) {
      tabSource.connect(mixDest);
    }
  }

  // Mix in microphone if requested
  if (options.mic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(mixDest);
      console.log('[offscreen] Mic mixed in');
    } catch (err) {
      console.warn('[offscreen] Mic access denied:', err.message);
    }
  }

  const mixedAudioTracks = mixDest.stream.getAudioTracks();
  console.log(`[offscreen] Mixed audio tracks: ${mixedAudioTracks.length}`);

  // Combine tracks into the final stream (audio-only skips video)
  const finalTracks = options.audioOnly
    ? [...mixedAudioTracks]
    : [...videoTracks, ...mixedAudioTracks];
  const finalStream = new MediaStream(finalTracks);

  activeRecordingId = crypto.randomUUID();
  chunkIndex        = 0;
  pendingWrites     = [];
  recordingStartMs  = Date.now();

  const mimeType = pickMimeType(mixedAudioTracks.length > 0, options.audioOnly);
  console.log(`[offscreen] MediaRecorder mimeType: ${mimeType}`);

  mediaRecorder = new MediaRecorder(finalStream, {
    mimeType,
    videoBitsPerSecond: 1_000_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) {
      const p = appendChunk(activeRecordingId, chunkIndex++, e.data)
        .catch(err => console.error('[offscreen] Chunk write failed:', err));
      pendingWrites.push(p);
    }
  };

  mediaRecorder.onerror = (e) => {
    console.error('[offscreen] MediaRecorder error:', e.error);
  };

  // 1-second timeslice — keeps memory usage flat for long recordings
  mediaRecorder.start(1000);
  console.log('[offscreen] Recording started');
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    throw new Error('Not recording');
  }

  return new Promise((resolve, reject) => {
    mediaRecorder.onstop = async () => {
      try {
        mediaRecorder.stream.getTracks().forEach(t => t.stop());

        if (audioContext) {
          audioContext.close();
          audioContext = null;
        }

        mediaRecorder = null;

        await Promise.all(pendingWrites);
        pendingWrites = [];

        const recordingId = activeRecordingId;
        const durationMs  = Date.now() - recordingStartMs;
        activeRecordingId = null;
        recordingStartMs  = 0;
        await assembleAndSave(recordingId, durationMs);
        console.log(`[offscreen] Assembled recording ${recordingId} (${Math.round(durationMs / 1000)}s)`);

        // Return recordingId to background.js — it will create the job and start upload
        resolve({ recordingId });
      } catch (err) {
        reject(err);
      }
    };

    mediaRecorder.stop();
  });
}
