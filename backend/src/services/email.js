// backend/src/services/email.js — Resend email client

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.FROM_EMAIL || 'onboarding@resend.dev';

/**
 * Send a completion email with links to the Drive recording and transcript Doc.
 * @param {string} to         — recipient email
 * @param {string} driveUrl   — Google Drive recording URL
 * @param {string} docUrl     — Google Doc transcript URL
 * @param {string} recordedAt — ISO timestamp of recording
 */
export async function sendCompletionEmail(to, driveUrl, docUrl, recordedAt) {
  console.log(`[email] Sending completion email to ${to}…`);
  const date = new Date(recordedAt).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  const { error } = await resend.emails.send({
    from: `Tab Recorder <${FROM}>`,
    to,
    subject: `Your recording transcript is ready — ${date}`,
    html: `
      <p>Hi,</p>
      <p>Your recording from <strong>${date}</strong> has been transcribed.</p>
      <ul>
        <li><a href="${docUrl}">View Transcript (Google Doc)</a></li>
        <li><a href="${driveUrl}">View Recording (Google Drive)</a></li>
      </ul>
      <p>— Tab Recorder</p>
    `,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}
