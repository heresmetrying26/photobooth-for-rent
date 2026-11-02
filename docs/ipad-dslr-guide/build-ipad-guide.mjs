// Builds the iPad + DSLR Photobooth Guide to PDF using headless Chrome/Edge.
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

function findBrowser() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'chromium',
    'google-chrome'
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'chrome';
}

const browser = process.argv[2] || findBrowser();
const htmlFile = path.join(dir, 'ipad-dslr-guide.html');
const outPdf1 = path.join(dir, 'photobooth4u-ipad-dslr-guide.pdf');
const outPdf2 = path.join(dir, '..', '..', 'public', 'photobooth4u-ipad-dslr-guide.pdf');
const outPdf3 = path.join(dir, '..', '..', 'public', 'lifetime', 'photobooth4u-ipad-dslr-guide.pdf');
const tmpOut = outPdf1 + '.tmp';

console.log('Using browser:', browser);
console.log('Rendering HTML:', htmlFile);

execFileSync(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-pdf-header-footer',
  '--print-to-pdf=' + tmpOut,
  '--virtual-time-budget=6000',
  pathToFileURL(htmlFile).href
], { stdio: 'inherit' });

copyFileSync(tmpOut, outPdf1);
copyFileSync(tmpOut, outPdf2);
copyFileSync(tmpOut, outPdf3);
try { unlinkSync(tmpOut); } catch {}

console.log('Successfully generated iPad + DSLR Guide PDF:');
console.log('  1. ' + outPdf1);
console.log('  2. ' + outPdf2);
console.log('  3. ' + outPdf3);

