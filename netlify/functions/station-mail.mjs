import {
  safe, json, EMAIL_RE, sendMail, checkLicense, guestViewMode, opKeyOf,
  throttle, recordFail, clientIp, DRIVE_SCRIPT_URL
} from '../lib/core.mjs';
import { verifyDesktopAppAuth } from '../lib/license.mjs';

const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;

function isSafeShareUrl(raw, reqOrigin) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  if (u.protocol !== 'https:' && !(reqOrigin && u.origin === reqOrigin)) return false;
  const host = u.hostname.toLowerCase();
  if (reqOrigin) {
    try {
      if (u.origin === reqOrigin) return true;
    } catch { }
  }
  return host === 'photobooth4u.netlify.app' || host === 'photobooth4u.com' || host.endsWith('.photobooth4u.com') || host === 'drive.google.com';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function kindLabel(kind) {
  if (kind === 'video') return '360 Video';
  if (kind === 'guestbook') return 'Video Guestbook';
  if (kind === 'gif') return 'GIF';
  if (kind === 'solo') return 'Photo';
  return 'Photo';
}

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ ok: false, error: 'Bad request' }, 400);

  const to = String(b.to || '').trim();
  if (!EMAIL_RE.test(to)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  const reqOrigin = (() => { try { return new URL(req.url).origin; } catch { return ''; } })();
  const shareUrl = String(b.shareUrl || '').trim();
  if (!shareUrl || shareUrl.length > 500 || !isSafeShareUrl(shareUrl, reqOrigin)) {
    return json({ ok: false, error: 'Invalid share link.' }, 400);
  }

  const ip = clientIp(req);
  const lim = await throttle('station-mail', ip, 40, 15 * 60000);
  if (lim.blocked) {
    return json({ ok: false, error: 'Too many emails sent recently. Wait a few minutes or scan the QR code.' }, 429);
  }

  let authorized = false;
  if (b.licence || b.token || b.desktopToken) {
    const desk = await verifyDesktopAppAuth(b, { requireOnline: true }).catch(() => null);
    if (desk && desk.ok) {
      authorized = true;
    } else if (b.token) {
      const lic = await checkLicense(b.token, String(b.deviceId || '')).catch(() => ({ valid: false }));
      if (lic && lic.valid) authorized = true;
    }
  }

  if (!authorized) {
    const folderId = String(b.folderId || '').trim();
    if (!ID_RE.test(folderId) || !shareUrl.includes(folderId)) {
      return json({ ok: false, error: 'Missing event authorization.' }, 403);
    }
    if ((await guestViewMode(folderId)) === 'only' && String(b.k || '') !== opKeyOf(folderId)) {
      return json({ ok: false, error: 'Private event gallery requires booth key.' }, 403);
    }
    try {
      const r = await fetch(DRIVE_SCRIPT_URL + '?action=list&folder=' + encodeURIComponent(folderId), {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) authorized = true;
    } catch {
      return json({ ok: false, error: 'Could not verify event folder. Try again.' }, 502);
    }
  }

  if (!authorized) {
    return json({ ok: false, error: 'Not authorized for this event.' }, 403);
  }

  await recordFail(lim);

  const eventName = String(b.eventName || 'Your Event').trim().slice(0, 100) || 'Your Event';
  const label = kindLabel(String(b.kind || ''));
  const subject = `${eventName} — Your ${label} is ready!`;
  const text = `Here is your ${label} from ${eventName}:\n\n${shareUrl}\n\nTap the link to view and save it to your phone.`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#F6F1EA;color:#1C1A1E;border-radius:16px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#C93D27;">photobooth4u</p>
      <h2 style="margin:0 0 10px;font-size:22px;line-height:1.25;">${escapeHtml(eventName)}</h2>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#423D44;">Your ${escapeHtml(label)} is ready to watch and save.</p>
      <p style="margin:0 0 20px;">
        <a href="${escapeHtml(shareUrl)}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:#C93D27;color:#ffffff;font-weight:800;text-decoration:none;font-size:15px;">Open &amp; Save ${escapeHtml(label)}</a>
      </p>
      <p style="margin:0;font-size:12px;color:#6B666C;word-break:break-all;">Or open: ${escapeHtml(shareUrl)}</p>
    </div>
  `.trim();

  try {
    await sendMail({ to, subject, text, html });
    return json({ ok: true });
  } catch (err) {
    const msg = err?.message || 'Could not send email.';
    const quotaReached = /daily email limit/i.test(msg);
    return json({ ok: false, error: msg, quotaReached }, 502);
  }
});

export const config = { path: '/api/station-mail' };
