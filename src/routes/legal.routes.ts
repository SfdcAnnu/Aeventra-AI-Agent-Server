/**
 * Public legal pages the mobile app and its Play listing link to. No auth.
 */
import { Router } from 'express';

export const legalRouter = Router();

const PAGE = (title: string, body: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Archon</title>
<style>body{margin:0;background:#070b16;color:#eaf1fb;font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:40px 22px 80px}h1{font-size:26px;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 8px;color:#3fdbe8}p,li{color:#c3cee2}a{color:#3fdbe8}
.muted{color:#8a99b5;font-size:13px}</style></head><body><div class="wrap">${body}</div></body></html>`;

legalRouter.get('/privacy', (_req, res) => {
  res.type('html').send(PAGE('Privacy Policy', `
    <h1>Archon — Privacy Policy</h1>
    <p class="muted">Last updated: 27 September 2026</p>
    <p>The Archon mobile app connects you to the AI agents in your own Salesforce organisation. It is used by administrators and staff of organisations that run the Archon platform.</p>
    <h2>What we access</h2>
    <p>When you sign in with Salesforce, you authorise the app through Salesforce's own login. We receive an access token that lets the app act as you against your organisation's data, and a refresh token so you stay signed in. These tokens are stored on the Archon server, encrypted, and are never placed in the app on your device. Your Salesforce password is never seen by the app.</p>
    <h2>What stays on your device</h2>
    <p>Only a revocable session token and the server address. No Salesforce data is stored on the device beyond what is shown on screen during use.</p>
    <h2>How your data is used</h2>
    <p>Messages you send to an agent are processed to produce a reply, using the AI model your organisation has configured. Conversations and agent activity are recorded in your organisation's own Salesforce org, under your organisation's control. We do not sell your data or use it for advertising.</p>
    <h2>Deleting your data</h2>
    <p>Sign out in the app to revoke the device session. To remove your stored connection entirely, disconnect Salesforce from the Archon platform, or contact your administrator. Account and data deletion requests can be sent to the address below.</p>
    <h2>Contact</h2>
    <p>Questions about this policy: <span>privacy@360smsapp.com</span></p>
  `));
});

legalRouter.get('/data-deletion', (_req, res) => {
  res.type('html').send(PAGE('Data Deletion', `
    <h1>Archon — Data Deletion</h1>
    <p>To delete the data associated with your Archon mobile sign-in:</p>
    <h2>1. In the app</h2>
    <p>Open Settings and tap Sign out. This revokes the session token on your device and on the server.</p>
    <h2>2. Remove the stored connection</h2>
    <p>Ask your administrator to disconnect your Salesforce connection on the Archon platform, which deletes the stored access and refresh tokens.</p>
    <h2>3. Full request</h2>
    <p>To request deletion of all associated records, email <span>privacy@360smsapp.com</span> from your work address.</p>
  `));
});
