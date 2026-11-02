// Prints guide.html to photobooth4u-setup-guide.pdf with headless Chrome/Chromium.
// Usage: node build-guide.mjs [path-to-chrome]
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || process.env.CHROME ||
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
   : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const out = path.join(dir, '..', '..', 'public', 'lifetime', 'photobooth4u-setup-guide.pdf');
const tmpOut = out + '.tmp';
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + tmpOut,
  '--virtual-time-budget=5000', pathToFileURL(path.join(dir, 'guide.html')).href], { stdio: 'inherit' });
copyFileSync(tmpOut, out);
try { unlinkSync(tmpOut); } catch {}
console.log('Wrote ' + out);
