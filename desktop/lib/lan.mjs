// iPad (or any tablet / phone) using this laptop's camera over the booth Wi-Fi.
//
// Safari on iPad has no USB, and an https page can't call a plain http laptop address.
// So the laptop serves the booth page itself on the same address as the guests' photo
// pages (http://<laptop>:47777/ipad/<PIN>), and that page talks to the laptop's own
// camera, photo folder and licence through the same-origin paths below. The booth on the
// iPad then uses the real camera shutter, live view and flash, exactly like the laptop's own window.
//
// Off by default. When it is on, nothing is served without the 6-digit PIN (kept in a
// cookie once typed), and wrong PINs are rate limited per device.
import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';

const COOKIE = 'pb_ipad';
const FORWARD = [/^\/api\//, /^\/helper(\/|$)/, /^\/local\/drive$/, /^\/bg\//, /^\/camera-test\/build\//, /^\/pay\//, /^\/fonts\//, /^\/img\//];
const MAX_BODY = 60 * 1024 * 1024;           // a photo or a few, as base64
const FAIL_MAX = 10, FAIL_MS = 10 * 60000;    // wrong PINs per device per 10 minutes
const fails = new Map();

export const newPin = () => String(randomInt(1000000)).padStart(6, '0');
export const validPin = (p) => /^\d{6}$/.test(String(p || ''));

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function simplePage(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#F5F1EA;color:#1C1A1E}' +
    '.c{max-width:420px;padding:28px;text-align:center}h1{font-size:22px;margin:0 0 10px}p{color:#5a5560;line-height:1.5}' +
    'input{font-size:28px;letter-spacing:.3em;text-align:center;width:9em;padding:12px;border:1px solid #cfc8bd;border-radius:12px}' +
    'button{font-size:17px;font-weight:700;margin-top:16px;padding:14px 26px;border:0;border-radius:12px;background:#1C1A1E;color:#fff}</style></head><body><div class="c">' + body + '</div></body></html>';
}
function send(res, status, type, body, extra) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...(extra || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const who = (req) => String((req.socket && req.socket.remoteAddress) || 'x');
function blocked(req) {
  const now = Date.now();
  const list = (fails.get(who(req)) || []).filter((t) => now - t < FAIL_MS);
  fails.set(who(req), list);
  return list.length >= FAIL_MAX;
}
function failed(req) { const l = fails.get(who(req)) || []; l.push(Date.now()); fails.set(who(req), l); }
function cookiePin(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=(\\d{6})(?:;|$)').exec(String(req.headers.cookie || ''));
  return m ? m[1] : '';
}

// deps: state() -> { on, pin }, boothPage({ extraHead }), handleWeb(Request) -> Response, setGuestView(mode), licenceOk()
// Returns an async (req, res) => boolean: true when it answered the request.
export function createLanHandler(deps) {
  return async function lan(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return false; }
    const p = url.pathname;
    const entry = /^\/ipad(?:\/(\d{6}))?\/?$/.exec(p);
    const forward = !entry && (FORWARD.some((r) => r.test(p)) || p === '/local/guestview');
    if (!entry && !forward) return false;
    const st = deps.state();

    if (entry) {
      if (!st.on) { send(res, 404, 'text/html; charset=utf-8', simplePage('iPad sharing is off', '<h1>iPad sharing is off</h1><p>On the laptop, open Setup → Share &amp; start and turn on &ldquo;Let an iPad use this laptop&rsquo;s camera&rdquo;.</p>')); return true; }
      if (!entry[1]) {
        send(res, 200, 'text/html; charset=utf-8', simplePage('Open the booth', '<h1>Type the laptop&rsquo;s PIN</h1><p>It is shown on the laptop in Setup → Share &amp; start.</p>' +
          '<form onsubmit="var v=this.pin.value.replace(/\\D/g,\'\');if(v.length===6)location.href=\'/ipad/\'+v;return false"><input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" autofocus><br><button type="submit">Open booth</button></form>'));
        return true;
      }
      if (blocked(req)) { send(res, 429, 'text/html; charset=utf-8', simplePage('Please wait', '<h1>Too many tries</h1><p>Wait a few minutes, then try again.</p>')); return true; }
      if (entry[1] !== st.pin) {
        failed(req);
        send(res, 403, 'text/html; charset=utf-8', simplePage('Wrong PIN', '<h1>That PIN isn&rsquo;t right</h1><p>Check the PIN on the laptop. It changes when the laptop makes a new one.</p><p><a href="/ipad">Try again</a></p>'));
        return true;
      }
      const host = String(req.headers.host || '');
      const base = host ? 'http://' + host : '';
      const head = '<script>window.__PB=window.__PB||{};window.__PB.lanRemote=' + JSON.stringify({ base }).replace(/</g, '\\u003c') + ';' +
        'try{Object.defineProperty(Navigator.prototype,"onLine",{get:function(){return true;},configurable:true});}catch(e){}' +
        'try{sessionStorage.removeItem("pb_open_tries");}catch(e){}</script>';
      const r = await deps.boothPage({ extraHead: head });
      if (r.locked) { send(res, 503, 'text/html; charset=utf-8', simplePage('Booth locked', '<h1>The laptop&rsquo;s booth is locked</h1><p>Open the app on the laptop and check its code is active.</p>')); return true; }
      send(res, 200, 'text/html; charset=utf-8', r.html, { 'set-cookie': COOKIE + '=' + st.pin + '; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly' });
      return true;
    }

    // Everything else the booth asks for: only with the PIN cookie, and only while sharing is on.
    if (!st.on || cookiePin(req) !== st.pin) { send(res, 401, 'application/json', JSON.stringify({ ok: false, error: 'locked', reason: 'pin' })); return true; }
    try {
      if (p === '/local/guestview') {
        if (req.method !== 'POST') { send(res, 405, 'application/json', '{"ok":false}'); return true; }
        let mode = '';
        try { mode = JSON.parse((await readBody(req)).toString('utf8')).mode; } catch { mode = ''; }
        send(res, 200, 'application/json', JSON.stringify({ ok: true, mode: deps.setGuestView(String(mode || '')) }));
        return true;
      }
      const headers = {};
      for (const k of ['content-type', 'authorization', 'x-device-id', 'accept', 'range']) if (req.headers[k]) headers[k] = String(req.headers[k]);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? await readBody(req) : undefined;
      const web = await deps.handleWeb(new Request('app://booth' + p + url.search, { method: req.method, headers, body: hasBody && body.length ? body : undefined }));
      const out = {};
      web.headers.forEach((v, k) => { if (k !== 'cross-origin-resource-policy') out[k] = v; });
      res.writeHead(web.status, out);
      if (!web.body) { res.end(); return true; }
      const stream = Readable.fromWeb(web.body);
      stream.on('error', () => { try { res.destroy(); } catch { /* closed */ } });
      res.on('close', () => { try { stream.destroy(); } catch { /* closed */ } });
      stream.pipe(res);
    } catch (e) {
      try { send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(e && e.message || e) })); } catch { /* closed */ }
    }
    return true;
  };
}
