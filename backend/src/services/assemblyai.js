// backend/src/services/assemblyai.js — AssemblyAI transcription client

const BASE_URL = 'https://api.assemblyai.com/v2';
const API_KEY  = () => process.env.ASSEMBLYAI_API_KEY;

const jsonHeaders = () => ({
  authorization: API_KEY(),
  'content-type': 'application/json',
});

/**
 * Upload an audio/video buffer to AssemblyAI's servers.
 * @param {Buffer} buffer — file contents (WebM, MP4, etc.)
 * @returns {string} upload_url
 */
export async function uploadAudioFile(buffer) {
  const res = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: {
      authorization: API_KEY(),
      'content-type': 'application/octet-stream',
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AssemblyAI upload failed (${res.status}): ${text}`);
  }

  const { upload_url } = await res.json();
  return upload_url;
}

/**
 * Submit an audio URL for transcription with speaker diarization.
 * @param {string} audioUrl — AssemblyAI-hosted URL from uploadAudio()
 * @returns {string} transcriptId
 */
export async function submitTranscription(audioUrl) {
  const res = await fetch(`${BASE_URL}/transcript`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      audio_url:      audioUrl,
      speaker_labels: true,
      speech_models:  ['universal-2'],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AssemblyAI submit failed (${res.status}): ${text}`);
  }

  const { id } = await res.json();
  return id;
}

/**
 * Poll until the transcript is complete or errored.
 * @param {string}   transcriptId
 * @param {Function} onProgress — called with current status string
 * @returns {{ text: string, utterances: Array }}
 */
export async function pollTranscription(transcriptId, onProgress) {
  const POLL_INTERVAL_MS = 5_000;
  const MAX_POLL_MS      = 90 * 60 * 1_000; // 90 minutes — covers 2+ hour recordings
  const startTime        = Date.now();

  while (true) {
    if (Date.now() - startTime > MAX_POLL_MS) {
      throw new Error('Transcription timed out after 90 minutes');
    }

    const res = await fetch(`${BASE_URL}/transcript/${transcriptId}`, {
      headers: jsonHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AssemblyAI poll failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    onProgress?.(data.status);

    if (data.status === 'completed') {
      return { text: data.text, utterances: data.utterances || [] };
    }

    if (data.status === 'error') {
      throw new Error(`Transcription failed: ${data.error}`);
    }

    // status is 'queued' or 'processing' — wait and retry
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}
