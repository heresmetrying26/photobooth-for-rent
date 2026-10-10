import { safe, json, checkLicense } from '../lib/core.mjs';

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => ({}));
  const r = await checkLicense(b.token, b.deviceId);
  return json(r.valid ? { valid: true, type: r.type, exp: r.exp, token: r.token, folderKey: r.folderKey || null, print: r.print, traditional: !!r.traditional, gif: r.gif !== false } : { valid: false, reason: r.reason });
});

export const config = { path: '/api/verify' };
