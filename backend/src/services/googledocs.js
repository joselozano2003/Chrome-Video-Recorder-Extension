// backend/src/services/googledocs.js — Google Docs API client
// Phase 7 will fill in the implementation.

/**
 * Create a formatted Google Doc with the transcript.
 * @param {string} title         — Doc title
 * @param {string} recordingDate — ISO date string
 * @param {string} driveUrl      — Link to the Drive recording
 * @param {string} transcriptText — Full transcript text
 * @param {Array}  utterances    — Speaker-diarized segments (optional)
 * @returns {{ docId: string, docUrl: string }}
 */
export async function createTranscriptDoc(title, recordingDate, driveUrl, transcriptText, utterances = []) {
  // TODO (Phase 7): implement using googleapis
  throw new Error('Not implemented yet');
}
