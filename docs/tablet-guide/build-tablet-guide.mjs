// Prints tablet-guide.html to public/lifetime/photobooth4u-tablet-guide.pdf with headless Chrome/Chromium.
// Usage: node build-tablet-guide.mjs [path-to-chrome]
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] || process.env.CHROME ||
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
   : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const out = path.join(dir, '..', '..', 'public', 'lifetime', 'photobooth4u-tablet-guide.pdf');
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + out,
  '--virtual-time-budget=5000', pathToFileURL(path.join(dir, 'tablet-guide.html')).href], { stdio: 'inherit' });
console.log('Wrote ' + out);
