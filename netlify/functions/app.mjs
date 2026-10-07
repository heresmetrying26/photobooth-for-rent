import booth from '../lib/booth.mjs';
import { safe, json, checkLicense } from '../lib/core.mjs';

// Runs inside the unlocked app: shows the countdown chip, re-checks the license
// every few minutes, and sends the person back to the lock screen when time is up
// (waiting for any photo session in progress to finish first).
const WATCHER = `
(function(){
  var L = window.__PB, TOKEN_KEY = 'pb_token', DEV_KEY = 'pb_device';
  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function lock(reason){
    try { sessionStorage.setItem('pb_notice', reason); } catch(e) {}
    location.reload();
  }
  function tryLock(reason){
    if (document.querySelector('.app-shell.capturing')) { setTimeout(function(){ tryLock(reason); }, 4000); return; }
    lock(reason);
  }
  var chip = document.createElement('div');
  chip.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;background:rgba(31,65,102,.9);color:#fff;font:600 12px Inter,system-ui,sans-serif;padding:6px 12px;border-radius:999px;pointer-events:none;display:none;';
  document.body.appendChild(chip);
  var locking = false;
  function tick(){
    var left = L.exp - Date.now();
    if (left <= 0) {
      if (!locking) { locking = true; tryLock(L.type === 'trial' ? 'trial-ended' : 'expired'); }
      return;
    }
    var m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    if (L.type === 'trial') {
      chip.style.display = 'block';
      chip.textContent = 'Trial \\u00b7 ' + pad(m) + ':' + pad(s) + ' left';
    } else if (left < 86400000) {
      chip.style.display = 'block';
      chip.textContent = 'Rental ends in ' + Math.floor(m / 60) + 'h ' + pad(m % 60) + 'm';
    } else {
      chip.style.display = 'none';
    }
  }
  tick(); setInterval(tick, 1000);
  function check(){
    fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: localStorage.getItem(TOKEN_KEY), deviceId: localStorage.getItem(DEV_KEY) })
    }).then(function(r){ return r.json(); }).then(function(j){
      if (j && j.valid === false) { if (!locking) { locking = true; tryLock(j.reason || 'invalid'); } }
      else if (j && j.valid) {
        L.exp = j.exp; if (j.token) localStorage.setItem(TOKEN_KEY, j.token);
        // Admin can switch printing on/off mid-rental; tell the booth.
        if (j.print && JSON.stringify(j.print) !== JSON.stringify(L.print)) {
          L.print = j.print;
          window.dispatchEvent(new Event('pb-print-change'));
        }
      }
    }).catch(function(){ /* offline: keep running until the known expiry */ });
  }
  setInterval(check, 5 * 60 * 1000);
})();
`;

export default safe(async (req) => {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const device = req.headers.get('x-device-id') || '';
  const res = await checkLicense(token, device);
  if (!res.valid) return json({ error: 'locked', reason: res.reason }, 401);

  // window.__PB must exist BEFORE the booth's own script runs, because the booth
  // reads it once at startup to fill in the Drive folder and show its QR. So it
  // goes in <head>. The watcher needs document.body, so it stays before </body>.
  // '<' is escaped so a folder name can never close the script tag early.
  const pb = JSON.stringify({ type: res.type, exp: res.exp, folderKey: res.folderKey || null, lockFolder: !!res.folderKey, print: res.print || { enabled: false, sizes: [] } }).replace(/</g, '\\u003c');
  const head = '<script>window.__PB=' + pb + ';</script>';
  const tail = '<script>' + WATCHER + '</script>';
  let html = booth;
  const h = html.indexOf('</head>');
  html = h >= 0 ? html.slice(0, h) + head + html.slice(h) : head + html;
  const i = html.lastIndexOf('</body>');
  html = i >= 0 ? html.slice(0, i) + tail + html.slice(i) : html + tail;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-refreshed-token': res.token
    }
  });
});

export const config = { path: '/api/app' };
