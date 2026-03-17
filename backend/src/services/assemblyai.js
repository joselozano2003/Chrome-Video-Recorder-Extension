// backend/src/services/assemblyai.js — AssemblyAI transcription client
// Phase 6 will fill in the implementation.

const BASE_URL = 'https://api.assemblyai.com/v2';
const API_KEY  = () => process.env.ASSEMBLYAI_API_KEY;

const headers = () => ({
  authorization: API_KEY(),
  'content-type': 'application/json',
});

/**
 * Submit an audio URL for transcription.
 * @param {string} audioUrl — public or signed URL to the audio file
 * @returns {string} transcriptId
 */
export async function submitTranscription(audioUrl) {
  // TODO (Phase 6): implement
  throw new Error('Not implemented yet');
}

/**
 * Poll until the transcript is complete or errored.
 * @param {string} transcriptId
 * @param {Function} onProgress — called with current status string
 * @returns {{ text: string, utterances: Array }}
 */
export async function pollTranscription(transcriptId, onProgress) {
  // TODO (Phase 6): implement polling with 30s delay
  throw new Error('Not implemented yet');
}
