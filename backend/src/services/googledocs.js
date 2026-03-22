// backend/src/services/googledocs.js — Google Docs API client

const DOCS_BASE  = 'https://docs.googleapis.com/v1/documents';

/**
 * Create a formatted Google Doc with the transcript.
 * @param {string} title          — Doc title
 * @param {string} recordingDate  — ISO date string
 * @param {string} driveUrl       — Link to the Drive recording
 * @param {string} transcriptText — Full transcript text
 * @param {Array}  utterances     — Speaker-diarized segments from AssemblyAI
 * @param {string} accessToken    — Google OAuth token with documents scope
 * @returns {{ docId: string, docUrl: string }}
 */
export async function createTranscriptDoc(title, recordingDate, driveUrl, transcriptText, utterances = [], accessToken, sessionFolderId = null) {
  const authHeader = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Step 1: Create the empty document
  const createRes = await fetch(DOCS_BASE, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ title }),
  });
  if (!createRes.ok) {
    throw new Error(`Docs create failed (${createRes.status}): ${await createRes.text()}`);
  }
  const { documentId } = await createRes.json();

  // Step 2: Build the document body as plain text
  const body = buildBody(recordingDate, driveUrl, transcriptText, utterances);

  // Step 3: Insert the text content via batchUpdate
  const updateRes = await fetch(`${DOCS_BASE}/${documentId}:batchUpdate`, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: body } }],
    }),
  });
  if (!updateRes.ok) {
    throw new Error(`Docs insert failed (${updateRes.status}): ${await updateRes.text()}`);
  }

  // Step 4: Move the doc into the session folder (alongside the recording)
  if (sessionFolderId) {
    const fileRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${documentId}?fields=parents`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (fileRes.ok) {
      const { parents } = await fileRes.json();
      const removeParents = (parents || []).join(',');
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${documentId}?addParents=${sessionFolderId}&removeParents=${removeParents}`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` } }
      );
    }
  }

  const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;
  return { docId: documentId, docUrl };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildBody(recordingDate, driveUrl, transcriptText, utterances) {
  const date = new Date(recordingDate).toLocaleString('en-US', {
    dateStyle: 'long', timeStyle: 'short',
  });

  let body = `Recording: ${date}\nDrive file: ${driveUrl}\n\n`;

  if (utterances.length > 0) {
    body += '── Transcript ──\n\n';
    for (const u of utterances) {
      body += `Speaker ${u.speaker} [${formatTime(u.start)}]  ${u.text}\n\n`;
    }
  } else {
    body += '── Transcript ──\n\n';
    body += transcriptText;
  }

  return body;
}

function formatTime(ms) {
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
