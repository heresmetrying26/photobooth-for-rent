// Standalone Rush ID app: /api/session (no licence check; see ../lib/sessionCore.mjs for the API).
import { makeHandler } from '../lib/sessionCore.mjs';
import { store } from '../lib/store.mjs';

export default makeHandler({ db: () => store('rushid-sessions') });
export const config = { path: '/api/session' };
