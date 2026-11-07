import { getStore } from '@netlify/blobs';
import { makeHandler } from '../../rush-id/netlify/lib/sessionCore.mjs';
import { json, checkLicense } from '../lib/core.mjs';

// Phone -> station photo transfer (the QR code) for the /rush station. The API itself is documented in
// rush-id/netlify/lib/sessionCore.mjs. Starting a session needs a valid code with "Rush ID station" on;
// a phone only ever adds photos to a session it has the 6-letter code for.
export default makeHandler({
  db: () => getStore({ name: 'rush-sessions', consistency: 'strong' }),
  authorize: async (req) => {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const res = await checkLicense(token, req.headers.get('x-device-id') || '');
    return res.valid && res.rushOpt ? true : json({ error: 'locked' }, 401);
  },
});

export const config = { path: '/api/rush/session' };
