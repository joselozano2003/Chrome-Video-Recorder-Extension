// backend/src/services/email.js — SendGrid email client
// Phase 7 will fill in the implementation.

const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';
const API_KEY      = () => process.env.SENDGRID_API_KEY;
const FROM_EMAIL   = () => process.env.FROM_EMAIL || 'noreply@example.com';

/**
 * Send a completion email with links to the Drive recording and transcript Doc.
 * @param {string} to         — recipient email
 * @param {string} driveUrl   — Google Drive recording URL
 * @param {string} docUrl     — Google Doc transcript URL
 * @param {string} recordedAt — ISO timestamp of recording
 */
export async function sendCompletionEmail(to, driveUrl, docUrl, recordedAt) {
  // TODO (Phase 7): implement
  throw new Error('Not implemented yet');
}
