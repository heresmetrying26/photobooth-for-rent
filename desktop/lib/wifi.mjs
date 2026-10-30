// The Wi-Fi this laptop is on right now (name, and password when the OS hands it over),
// so the booth can print a "Join Wi-Fi" QR without anyone typing it.
// Windows: `netsh wlan` (the password needs the profile exported with key=clear).
// Mac: `networksetup` for the name; the password comes from the Keychain, which asks the operator once.
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeout || 6000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

async function winSsid() {
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  // "SSID : name" (the line for "BSSID" must not match); only while the adapter is connected.
  if (/^\s*State\s*:\s*(?!connected)/im.test(out) && !/^\s*State\s*:\s*connected/im.test(out)) return '';
  const m = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(out);
  return m ? m[1] : '';
}

// Returns { pass, open }: pass is null when Windows would not release it.
async function winPassword(ssid) {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pb4u-wifi-'));
    await run('netsh', ['wlan', 'export', 'profile', 'name=' + ssid, 'key=clear', 'folder=' + dir]);
    const f = readdirSync(dir).find((n) => /\.xml$/i.test(n));
    if (!f) return { pass: null, open: false };
    const xml = readFileSync(join(dir, f), 'utf8');
    const auth = (/<authentication>\s*([^<\s]+)\s*<\/authentication>/i.exec(xml) || [])[1] || '';
    if (/^open$/i.test(auth)) return { pass: '', open: true };
    const k = /<keyMaterial>([^<]*)<\/keyMaterial>/i.exec(xml);
    const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return { pass: k ? unesc(k[1]) : null, open: false };
  } catch { return { pass: null, open: false }; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } }
}

async function macDevice() {
  const out = await run('networksetup', ['-listallhardwareports']);
  const m = /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\nDevice:\s*(\S+)/i.exec(out);
  return m ? m[1] : 'en0';
}
async function macSsid() {
  const dev = await macDevice();
  const a = await run('networksetup', ['-getairportnetwork', dev]);
  const m = /Current Wi-Fi Network:\s*(.+?)\s*$/m.exec(a);
  if (m) return m[1];
  // Newer macOS hides it from the line above; the interface summary still has it.
  const b = await run('ipconfig', ['getsummary', dev]);
  const n = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(b);
  return n && !/<redacted>/i.test(n[1]) ? n[1] : '';
}
async function macPassword(ssid) {
  // Asks the operator to allow Keychain access; a "no" (or a timeout) leaves the password to be typed.
  const out = await run('security', ['find-generic-password', '-D', 'AirPort network password', '-wa', ssid], 60000);
  return out ? out.replace(/\r?\n$/, '') : null;
}

let cache = { ssid: '', pass: null, open: false, tried: false };

// force: look the password up again (after a failed try, or the operator pressed "Use current Wi-Fi").
export async function detectWifi(force) {
  if (!IS_WIN && !IS_MAC) return { ssid: '', pass: null, open: false, passKnown: false };
  const ssid = IS_WIN ? await winSsid() : await macSsid();
  if (!ssid) { cache = { ssid: '', pass: null, open: false, tried: false }; return { ssid: '', pass: null, open: false, passKnown: false }; }
  if (ssid !== cache.ssid || (force && cache.pass === null)) {
    cache = { ssid, pass: null, open: false, tried: true };
    if (IS_WIN) { const r = await winPassword(ssid); cache.pass = r.pass; cache.open = r.open; }
    else cache.pass = await macPassword(ssid);
  }
  return { ssid, pass: cache.pass === null ? '' : cache.pass, open: cache.open, passKnown: cache.pass !== null };
}
