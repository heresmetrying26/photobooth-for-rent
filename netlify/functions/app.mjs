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
      else if (j && j.valid) { L.exp = j.exp; if (j.token) localStorage.setItem(TOKEN_KEY, j.token); }
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

  const inject = '<script>window.__PB=' + JSON.stringify({ type: res.type, exp: res.exp, folderKey: res.folderKey || null, lockFolder: !!res.folderKey }) + ';' + WATCHER + '</script>';
  const i = booth.lastIndexOf('</body>');
  const html = i >= 0 ? booth.slice(0, i) + inject + booth.slice(i) : booth + inject;

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
