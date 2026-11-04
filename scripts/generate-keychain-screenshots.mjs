import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDirDocs = path.join(rootDir, 'docs', 'keychain-guide', 'img');
const outDirPublic = path.join(rootDir, 'public', 'keychain-guide', 'img');

fs.mkdirSync(outDirDocs, { recursive: true });
fs.mkdirSync(outDirPublic, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/protected/booth.html';
  const filePath = path.join(rootDir, reqPath);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    res.writeHead(403);
    res.end('Directory listing denied');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const port = 8792;
const tmpUserData = path.join(os.tmpdir(), 'chrome-keychain-' + Date.now());
fs.mkdirSync(tmpUserData, { recursive: true });

server.listen(port, async () => {
  console.log('Server started on http://127.0.0.1:' + port);
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=9225',
    '--user-data-dir=' + tmpUserData,
    '--window-size=1440,1100',
    '--hide-scrollbars'
  ]);

  await new Promise(r => setTimeout(r, 1500));

  try {
    const jsonRes = await fetch('http://127.0.0.1:9225/json');
    const tabs = await jsonRes.json();
    const target = tabs.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://')) || tabs[0];
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    let id = 1;
    const callbacks = new Map();
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data);
        callbacks.delete(data.id);
      }
    };

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const msgId = id++;
        callbacks.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);
    console.log('Connected to Chrome DevTools Protocol');

    await send('Page.enable');
    await send('DOM.enable');
    await send('Runtime.enable');

    console.log('Navigating to booth...');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/protected/booth.html` });
    await new Promise(r => setTimeout(r, 3000));

    // Setup mock frame and navigate to step 3
    console.log('Switching to setup, creating keychain frame, and selecting framesheet...');
    const setupResult = await send('Runtime.evaluate', {
      expression: `(async function() {
        document.body.classList.remove('welcome-on');
        switchTab('setup');

        // Create sample 2.5x7.5 strip frame canvas (750x2250 px)
        const fc = document.createElement('canvas');
        fc.width = 750; fc.height = 2250;
        const fx = fc.getContext('2d');
        
        // Background
        const grad = fx.createLinearGradient(0, 0, 750, 2250);
        grad.addColorStop(0, '#fbf8f3');
        grad.addColorStop(1, '#f0e8dc');
        fx.fillStyle = grad;
        fx.fillRect(0, 0, 750, 2250);
        
        // Header
        fx.fillStyle = '#C93D27';
        fx.font = 'bold 44px sans-serif';
        fx.textAlign = 'center';
        fx.fillText('LUCAS & EMMA', 375, 110);
        fx.fillStyle = '#6B666C';
        fx.font = '600 24px sans-serif';
        fx.fillText('KEYCHAIN SOUVENIR · 2.5×7.5 IN', 375, 155);

        // 3 Photo cutouts (transparent)
        const spots = [
          { x: 0.08, y: 0.085, w: 0.84, h: 0.25 },
          { x: 0.08, y: 0.365, w: 0.84, h: 0.25 },
          { x: 0.08, y: 0.645, w: 0.84, h: 0.25 }
        ];

        // Draw photo cutout frames with gold border
        spots.forEach((sp, i) => {
          const sx = Math.round(sp.x * 750), sy = Math.round(sp.y * 2250);
          const sw = Math.round(sp.w * 750), sh = Math.round(sp.h * 2250);
          fx.clearRect(sx, sy, sw, sh);
          fx.strokeStyle = '#D4AF37';
          fx.lineWidth = 6;
          fx.strokeRect(sx - 3, sy - 3, sw + 6, sh + 6);
        });

        // Bottom dedication
        fx.fillStyle = '#1C1A1E';
        fx.font = '500 24px sans-serif';
        fx.fillText('October 24, 2026', 375, 2140);

        const frameDataUrl = fc.toDataURL('image/png');
        const frameId = 'kc-frame-25x75';
        ASSETS[frameId] = { url: frameDataUrl, kind: 'frame' };

        myFrames = [{
          id: frameId,
          name: 'Keychain 2.5×7.5 (3-Shot)',
          w: 750,
          h: 2250,
          spots: spots
        }];
        activeFrameId = frameId;

        // Populate sample shotCanvases for realistic preview
        shotCanvases = [1, 2, 3].map(n => {
          const sc = document.createElement('canvas');
          sc.width = 600; sc.height = 450;
          const sx = sc.getContext('2d');
          sx.fillStyle = n === 1 ? '#8cb89f' : n === 2 ? '#b88c9f' : '#8c9fb8';
          sx.fillRect(0, 0, 600, 450);
          sx.fillStyle = '#ffffff';
          sx.font = 'bold 54px sans-serif';
          sx.textAlign = 'center';
          sx.fillText('GUEST PHOTO #' + n, 300, 240);
          return sc;
        });
        state = 'result';

        // Select framesheet layout
        currentLayout = 'framesheet';
        setupLayout = 'framesheet';
        sheetSize = 'A4';
        sheet = {
          pattern: 'three-strips',
          items: [
            { f: frameId, cx: 1/6, cy: 0.5, s: 0.95, r: 0 },
            { f: frameId, cx: 3/6, cy: 0.5, s: 0.95, r: 0 },
            { f: frameId, cx: 5/6, cy: 0.5, s: 0.95, r: 0 }
          ]
        };

        // Switch to Step 3
        goStep(3);
        if (typeof buildFramePick === 'function') buildFramePick();
        if (typeof buildSheetPatterns === 'function') buildSheetPatterns();
        if (typeof redrawAll === 'function') redrawAll();
        if (typeof refreshPrintUI === 'function') refreshPrintUI();

        return {
          ok: true,
          step: 3,
          hasPanel: !!document.getElementById('myFramesPanel'),
          hasCanvas: !!document.getElementById('setupPreviewCanvas')
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Setup result:', setupResult.result && setupResult.result.value);

    await new Promise(r => setTimeout(r, 2000));

    // Helper to capture element screenshot
    async function captureElement(selector, filename, padding = 16) {
      const clipRes = await send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('${selector}');
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return {
            x: Math.max(0, r.left - ${padding}),
            y: Math.max(0, r.top - ${padding}),
            width: r.width + ${padding * 2},
            height: r.height + ${padding * 2}
          };
        })()`,
        returnByValue: true
      });

      if (!clipRes.result || !clipRes.result.value) {
        console.error('Element not found:', selector);
        return;
      }

      await new Promise(r => setTimeout(r, 400));
      const clip = clipRes.result.value;
      const ss = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
      });

      const buf = Buffer.from(ss.data, 'base64');
      fs.writeFileSync(path.join(outDirDocs, filename), buf);
      fs.writeFileSync(path.join(outDirPublic, filename), buf);
      console.log('Saved:', filename, buf.length, 'bytes');
    }

    // 1. Layout selector in Step 3
    await captureElement('#layoutGrid', '1-step3-layout-grid.png', 16);

    // 2. Frames on this sheet panel
    await captureElement('#myFramesPanel', '2-step3-framesheet-panel.png', 16);

    // 3. Setup Preview Canvas
    await captureElement('#previewSection', '3-step3-preview-sheet.png', 16);

    // 4. Open Print Modal and capture print settings with keychain toggle
    console.log('Opening Print modal...');
    await send('Runtime.evaluate', {
      expression: `(() => {
        openPrintModal();
        printSize = 'A4';
        keychainOn = true;
        document.getElementById('keychainToggle').checked = true;
        refreshPrintUI();
      })()`
    });
    await new Promise(r => setTimeout(r, 1200));

    await captureElement('#printModal .pm-card', '4-print-settings-modal.png', 16);

    // 5. Open Print Preview Overlay (the full page before printing)
    console.log('Opening Print preview overlay...');
    await send('Runtime.evaluate', {
      expression: `(() => {
        closePrintModal();
        showPrintPreview(false, 1, true);
      })()`
    });
    await new Promise(r => setTimeout(r, 1500));

    await captureElement('#ppvOverlay .ppv-card', '5-print-preview-overlay.png', 16);

    console.log('All screenshots successfully captured!');
    ws.close();
  } catch (err) {
    console.error('Error during capture:', err);
  } finally {
    chrome.kill();
    server.close();
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch {}
    console.log('Cleaned up resources');
  }
});
