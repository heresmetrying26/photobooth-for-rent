import { safe, json, getSettings } from '../lib/core.mjs';

// Public: tells the About page which free trial code to advertise, so the code
// lives only in TRIAL_PASSWORD / Admin settings and is never hardcoded in HTML.
export default safe(async () => {
  const s = await getSettings();
  const code = String(s.trialPassword || '').trim();
  return json(s.trialEnabled && code ? { enabled: true, code } : { enabled: false });
});

export const config = { path: '/api/trial' };
