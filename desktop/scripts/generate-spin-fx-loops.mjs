// Procedural generator for all 40 spin-fx video loops (WebM VP9 alpha & MP4 H.264)
// and WebP thumbnails. Runs 100% locally with zero AI and zero external dependencies.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX_DIR = join(__dirname, '..', 'resources', 'spin-fx');
const THUMBS_DIR = join(FX_DIR, 'thumbs');
const CATALOG_PATH = join(FX_DIR, 'catalog.json');

const INSTALLED_DIR = process.env.PB4U_INSTALLED_DIR || null;

// Find ffmpeg
const FFMPEG_CANDIDATES = [
  process.env.PB4U_FFMPEG,
  join(__dirname, '..', 'build', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  join(__dirname, '..', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  'ffmpeg'
];

let FFMPEG = null;
for (const c of FFMPEG_CANDIDATES) {
  if (c && existsSync(c)) {
    FFMPEG = c;
    break;
  }
}
if (!FFMPEG) FFMPEG = 'ffmpeg';

const args = process.argv.slice(2);
const onlyFilter = (args.find(a => a.startsWith('--only=')) || '').slice(7) || null;
const isSd = args.includes('--sd') || args.includes('--540p');
const isLandscape = args.includes('--landscape');
const is1080p = args.includes('--1080p') || !isSd;

const LOOPS_DIR = isLandscape ? join(FX_DIR, 'loops', 'landscape') : join(FX_DIR, 'loops');

const W = isLandscape ? (is1080p ? 1920 : 960) : (is1080p ? 1080 : 540);
const H = isLandscape ? (is1080p ? 1080 : 540) : (is1080p ? 1920 : 960);
const FPS = is1080p ? 30 : 25;
const DURATION = (is1080p || args.includes('--3s')) ? 3 : 2; // 3s seamless loop for 1080p
const FRAMES = FPS * DURATION;

mkdirSync(LOOPS_DIR, { recursive: true });
mkdirSync(THUMBS_DIR, { recursive: true });

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// Helper drawing utilities directly on Uint8Array RGBA buffer
function drawRect(buf, rx, ry, rw, rh, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(rx)), x1 = Math.min(W, Math.floor(rx + rw));
  const y0 = Math.max(0, Math.floor(ry)), y1 = Math.min(H, Math.floor(ry + rh));
  for (let y = y0; y < y1; y++) {
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const idx = row + x * 4;
      if (a === 255) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = 255;
      } else {
        const sa = a / 255, da = (buf[idx + 3] / 255) * (1 - sa);
        const outA = sa + da;
        if (outA > 0) {
          buf[idx] = Math.min(255, Math.floor((r * sa + buf[idx] * da) / outA));
          buf[idx + 1] = Math.min(255, Math.floor((g * sa + buf[idx + 1] * da) / outA));
          buf[idx + 2] = Math.min(255, Math.floor((b * sa + buf[idx + 2] * da) / outA));
          buf[idx + 3] = Math.min(255, Math.floor(outA * 255));
        }
      }
    }
  }
}

function drawCircle(buf, cx, cy, rad, r, g, b, a = 255, soft = false) {
  const icx = Math.round(cx), icy = Math.round(cy), irad = Math.round(rad);
  if (irad <= 0) return;
  const x0 = Math.max(0, icx - irad), x1 = Math.min(W, icx + irad);
  const y0 = Math.max(0, icy - irad), y1 = Math.min(H, icy + irad);
  const radSq = irad * irad;
  for (let y = y0; y < y1; y++) {
    const dy = y - icy;
    const dySq = dy * dy;
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const dx = x - icx;
      const dSq = dx * dx + dySq;
      if (dSq <= radSq) {
        const idx = row + x * 4;
        let alpha = a;
        if (soft) {
          const dist = Math.sqrt(dSq);
          alpha = Math.floor(a * (1 - dist / irad));
        }
        if (alpha <= 0) continue;
        const sa = alpha / 255, da = (buf[idx + 3] / 255) * (1 - sa);
        const outA = sa + da;
        if (outA > 0) {
          buf[idx] = Math.min(255, Math.floor((r * sa + buf[idx] * da) / outA));
          buf[idx + 1] = Math.min(255, Math.floor((g * sa + buf[idx + 1] * da) / outA));
          buf[idx + 2] = Math.min(255, Math.floor((b * sa + buf[idx + 2] * da) / outA));
          buf[idx + 3] = Math.min(255, Math.floor(outA * 255));
        }
      }
    }
  }
}

function drawLine(buf, px0, py0, px1, py1, r, g, b, a = 255, thickness = 1) {
  let x0 = Math.round(px0), y0 = Math.round(py0);
  let x1 = Math.round(px1), y1 = Math.round(py1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, cx = x0, cy = y0;
  let steps = 0;
  const maxSteps = (dx + dy + 2) * 2;
  while (steps++ < maxSteps) {
    if (thickness <= 1) {
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
        const idx = (cy * W + cx) * 4;
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = a;
      }
    } else {
      drawCircle(buf, cx, cy, thickness / 2, r, g, b, a);
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

function drawHeart(buf, cx, cy, size, r, g, b, a = 255) {
  const rCircle = size * 0.3;
  drawCircle(buf, cx - rCircle * 0.9, cy - rCircle * 0.3, rCircle, r, g, b, a);
  drawCircle(buf, cx + rCircle * 0.9, cy - rCircle * 0.3, rCircle, r, g, b, a);
  // Triangle bottom
  const yBot = cy + size * 0.8;
  const halfW = size * 0.65;
  for (let y = Math.floor(cy - rCircle * 0.3); y < yBot; y++) {
    if (y < 0 || y >= H) continue;
    const progress = (y - (cy - rCircle * 0.3)) / (yBot - (cy - rCircle * 0.3));
    const span = halfW * (1 - progress);
    const x0 = Math.max(0, Math.floor(cx - span));
    const x1 = Math.min(W, Math.ceil(cx + span));
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const idx = row + x * 4;
      buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = a;
    }
  }
}

function drawStar(buf, cx, cy, rad, r, g, b, a = 255) {
  // 4-point star glint
  drawLine(buf, cx - rad * 2, cy, cx + rad * 2, cy, r, g, b, a, 2);
  drawLine(buf, cx, cy - rad * 2, cx, cy + rad * 2, r, g, b, a, 2);
  drawCircle(buf, cx, cy, rad * 0.8, r, g, b, a, true);
}

// Deterministic Pseudo-Random
function createRng(seed = 1234567) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// Generate the frame data generator for each effect
function createEffectRenderer(id, isWebm) {
  const rng = createRng(id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 100));

  if (id.includes('confetti_gold')) {
    const P = 75;
    const parts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 8 + rng() * 8,
      h: 12 + rng() * 10,
      vY: 1 + Math.floor(rng() * 2), // 1 or 2 wraps per 2s
      vSpin: 2 + Math.floor(rng() * 4),
      c: rng() > 0.4 ? [255, 215, 0] : [230, 180, 40]
    }));
    return (buf, t) => {
      for (const p of parts) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY) * 25 + W) % W;
        const spin = Math.sin((t * p.vSpin + p.x) * Math.PI * 2);
        const w = Math.max(2, Math.floor(p.w * Math.abs(spin)));
        drawRect(buf, x, y, w, p.h, p.c[0], p.c[1], p.c[2], 240);
      }
    };
  }

  if (id.includes('confetti_multi')) {
    const P = 80;
    const colors = [
      [255, 60, 90], [50, 180, 255], [255, 220, 40],
      [80, 220, 120], [255, 140, 20], [220, 80, 255]
    ];
    const parts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 7 + rng() * 8,
      h: 10 + rng() * 10,
      vY: 1 + Math.floor(rng() * 2),
      vSpin: 2 + Math.floor(rng() * 4),
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const p of parts) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 20 + W) % W;
        const spin = Math.sin((t * p.vSpin + p.x) * Math.PI * 2);
        const w = Math.max(2, Math.floor(p.w * Math.abs(spin)));
        drawRect(buf, x, y, w, p.h, p.c[0], p.c[1], p.c[2], 240);
      }
    };
  }

  if (id.includes('streamers') || id.includes('ribbon')) {
    const P = 6;
    const colors = [
      [255, 215, 0], [255, 80, 120], [60, 220, 240],
      [180, 80, 255], [255, 160, 50], [255, 230, 120]
    ];
    const streamers = Array.from({ length: P }, (v, i) => ({
      x0: (W / (P + 1)) * (i + 1) + (rng() - 0.5) * 40,
      period: 120 + rng() * 60,
      amp: 30 + rng() * 25,
      thick: 5 + rng() * 4,
      c: colors[i % colors.length],
      vY: 1
    }));
    return (buf, t) => {
      for (const s of streamers) {
        const yOffset = (t * s.vY * H) % H;
        for (let y = 0; y < H; y += 4) {
          const effY = (y - yOffset + H) % H;
          const x = s.x0 + Math.sin((effY / s.period) * Math.PI * 2) * s.amp;
          drawCircle(buf, x, y, s.thick, s.c[0], s.c[1], s.c[2], 230);
        }
      }
    };
  }

  if (id.includes('balloons')) {
    const P = 14;
    const colors = [
      [255, 180, 190], [180, 230, 255], [200, 190, 255],
      [255, 240, 180], [255, 205, 180], [190, 250, 220]
    ];
    const balloons = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 18 + rng() * 12,
      vY: 1 + Math.floor(rng() * 2), // rises upward
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const b of balloons) {
        const y = (b.y - t * b.vY * H + H * 2) % H;
        const x = (b.x + Math.sin(t * Math.PI * 2 * b.vY + b.y) * 20 + W) % W;
        drawCircle(buf, x, y, b.rad, b.c[0], b.c[1], b.c[2], 220);
        drawCircle(buf, x - b.rad * 0.3, y - b.rad * 0.3, b.rad * 0.3, 255, 255, 255, 120);
        drawLine(buf, x, y + b.rad, x + 3, y + b.rad + 20, 200, 200, 200, 180, 1);
      }
    };
  }

  if (id.includes('hearts')) {
    const P = 25;
    const hearts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 16 + rng() * 14,
      vY: 1 + Math.floor(rng() * 2),
      c: rng() > 0.4 ? [255, 80, 120] : [255, 140, 170]
    }));
    return (buf, t) => {
      for (const h of hearts) {
        const y = (h.y - t * h.vY * H + H * 2) % H;
        const x = (h.x + Math.sin(t * Math.PI * 2 * h.vY + h.y) * 25 + W) % W;
        drawHeart(buf, x, y, h.sz, h.c[0], h.c[1], h.c[2], 220);
      }
    };
  }

  if (id.includes('petals') || id.includes('rose')) {
    const P = 45;
    const isRed = id.includes('red') || id.includes('rose');
    const petals = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 10 + rng() * 10,
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 3),
      c: isRed ? (rng() > 0.3 ? [210, 25, 45] : [170, 15, 30]) : [250, 245, 240]
    }));
    return (buf, t) => {
      for (const p of petals) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 35 + W) % W;
        const rocking = Math.abs(Math.sin((t * p.spin + p.x) * Math.PI * 2));
        const w = Math.max(3, Math.floor(p.sz * rocking));
        drawCircle(buf, x, y, w, p.c[0], p.c[1], p.c[2], 225);
      }
    };
  }

  if (id.includes('autumn_leaves')) {
    const P = 40;
    const colors = [
      [220, 70, 30], [235, 130, 20], [200, 45, 25], [240, 180, 30]
    ];
    const leaves = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 12 + rng() * 10,
      vY: 1 + Math.floor(rng() * 2),
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const l of leaves) {
        const y = (l.y + t * l.vY * H) % H;
        const x = (l.x + Math.sin(t * Math.PI * 2 * l.vY + l.y) * 40 + W) % W;
        drawCircle(buf, x, y, l.sz, l.c[0], l.c[1], l.c[2], 230);
      }
    };
  }

  if (id.includes('cash_rain')) {
    const P = 30;
    const bills = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 26 + rng() * 12,
      h: 14 + rng() * 6,
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 3)
    }));
    return (buf, t) => {
      for (const b of bills) {
        const y = (b.y + t * b.vY * H) % H;
        const x = (b.x + Math.sin(t * Math.PI * 2 * b.vY + b.y) * 30 + W) % W;
        const s = Math.abs(Math.sin((t * b.spin + b.x) * Math.PI * 2));
        const curW = Math.max(4, Math.floor(b.w * s));
        drawRect(buf, x, y, curW, b.h, 75, 145, 85, 240);
        drawRect(buf, x + 2, y + 2, Math.max(1, curW - 4), b.h - 4, 110, 185, 120, 255);
      }
    };
  }

  if (id.includes('halloween_bats')) {
    const P = 12;
    const bats = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 14 + rng() * 10,
      vY: 1,
      vX: 1 + Math.floor(rng() * 2)
    }));
    return (buf, t) => {
      for (const b of bats) {
        const y = (b.y + Math.sin(t * Math.PI * 4 + b.x) * 40 + H) % H;
        const x = (b.x - t * b.vX * W + W * 2) % W;
        const flap = Math.sin(t * Math.PI * 12 + b.y) * b.sz * 0.5;
        drawCircle(buf, x, y, b.sz * 0.4, 25, 25, 30, 245);
        drawLine(buf, x, y, x - b.sz, y - flap, 25, 25, 30, 245, 3);
        drawLine(buf, x, y, x + b.sz, y - flap, 25, 25, 30, 245, 3);
      }
    };
  }

  if (id.includes('bokeh')) {
    const P = 24;
    const circles = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 30 + rng() * 45,
      vY: 1,
      c: rng() > 0.3 ? [255, 200, 80] : [255, 235, 150]
    }));
    return (buf, t) => {
      for (const c of circles) {
        const y = (c.y - t * c.vY * H + H * 2) % H;
        const x = (c.x + Math.sin(t * Math.PI * 2 + c.y) * 15 + W) % W;
        drawCircle(buf, x, y, c.rad, c.c[0], c.c[1], c.c[2], 100, true);
      }
    };
  }

  if (id.includes('champagne_bubbles')) {
    const P = 55;
    const bubbles = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 3 + rng() * 7,
      vY: 1 + Math.floor(rng() * 3),
      c: [255, 220, 110]
    }));
    return (buf, t) => {
      for (const b of bubbles) {
        const y = (b.y - t * b.vY * H + H * 2) % H;
        const x = (b.x + Math.sin(t * Math.PI * 4 * b.vY + b.y) * 12 + W) % W;
        drawCircle(buf, x, y, b.rad, b.c[0], b.c[1], b.c[2], 180, true);
        drawCircle(buf, x - b.rad * 0.3, y - b.rad * 0.3, b.rad * 0.25, 255, 255, 255, 240);
      }
    };
  }

  if (id.includes('sparkler') || id.includes('fireworks') || id.includes('nye')) {
    const P = 90;
    const sparks = Array.from({ length: P }, () => ({
      x0: rng() > 0.5 ? W * 0.25 : W * 0.75,
      y0: H * 0.85,
      angle: (rng() * 0.8 - 0.4) * Math.PI,
      spd: 120 + rng() * 260,
      life: 0.5 + rng() * 0.5,
      c: rng() > 0.3 ? [255, 225, 90] : [255, 255, 255]
    }));
    return (buf, t) => {
      for (const s of sparks) {
        const progress = (t * 2 + s.life) % 1.0;
        const dist = progress * s.spd;
        const x = s.x0 + Math.sin(s.angle) * dist;
        const y = s.y0 - Math.cos(s.angle) * dist + progress * progress * 80;
        const a = Math.floor(255 * (1 - progress));
        drawCircle(buf, x, y, 2, s.c[0], s.c[1], s.c[2], a);
      }
    };
  }

  if (id.includes('gold_dust') || id.includes('fairy_dust') || id.includes('silver_shimmer')) {
    const P = 85;
    const isSilver = id.includes('silver');
    const specks = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 2 + rng() * 3,
      vY: 1,
      freq: 1 + Math.floor(rng() * 4),
      c: isSilver ? [220, 230, 255] : [255, 215, 75]
    }));
    return (buf, t) => {
      for (const s of specks) {
        const y = (s.y + t * s.vY * H) % H;
        const x = (s.x + Math.sin(t * Math.PI * 2 * s.freq + s.y) * 20 + W) % W;
        const twinkle = Math.abs(Math.sin((t * s.freq + s.x) * Math.PI * 2));
        const rad = s.rad * (0.6 + twinkle * 0.8);
        drawStar(buf, Math.floor(x), Math.floor(y), rad, s.c[0], s.c[1], s.c[2], Math.floor(200 * twinkle));
      }
    };
  }

  if (id.includes('snow_blizzard')) {
    const P = 90;
    const flakes = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 2 + rng() * 4,
      vY: 1 + Math.floor(rng() * 2),
      drift: 20 + rng() * 30
    }));
    return (buf, t) => {
      for (const f of flakes) {
        const y = (f.y + t * f.vY * H) % H;
        const x = (f.x + Math.sin(t * Math.PI * 2 * f.vY + f.y) * f.drift + W) % W;
        drawCircle(buf, x, y, f.rad, 240, 245, 255, 210, true);
      }
    };
  }

  if (id.includes('laser_beams')) {
    const colors = [[0, 255, 120], [255, 0, 100], [0, 200, 255]];
    return (buf, t) => {
      for (let i = 0; i < 4; i++) {
        const angle = (t * Math.PI * 2 + (i * Math.PI) / 2) % (Math.PI * 2);
        const x1 = W / 2 + Math.cos(angle) * W * 0.9;
        const y1 = H / 2 + Math.sin(angle) * H * 0.9;
        const c = colors[i % colors.length];
        drawLine(buf, W / 2, H / 2, Math.floor(x1), Math.floor(y1), c[0], c[1], c[2], 220, 3);
      }
    };
  }

  if (id.includes('audio_equalizer')) {
    const BARS = 18;
    return (buf, t) => {
      const barW = Math.floor(W / (BARS + 2));
      for (let i = 0; i < BARS; i++) {
        const phase = (t * Math.PI * 4 + (i / BARS) * Math.PI * 2);
        const h = Math.floor(40 + (Math.sin(phase) * 0.5 + 0.5) * 160);
        const x = Math.floor((i + 1) * barW);
        const y = H - h - 30;
        drawRect(buf, x + 4, y, barW - 8, h, 0, 220, 255, 220);
      }
    };
  }

  if (id.includes('vhs_glitch') || id.includes('film_8mm')) {
    return (buf, t) => {
      // scanlines
      for (let y = 0; y < H; y += 4) {
        drawRect(buf, 0, y, W, 1, 60, 60, 80, 70);
      }
      // occasional glitch band
      const bandY = Math.floor((t * 3 * H) % H);
      drawRect(buf, 0, bandY, W, 12, 180, 220, 255, 90);
    };
  }

  if (id.includes('action_speed_lines')) {
    return (buf, t) => {
      const cx = W / 2, cy = H / 2;
      for (let i = 0; i < 28; i++) {
        const baseAngle = (i / 28) * Math.PI * 2;
        const angle = baseAngle + Math.sin(t * Math.PI * 4 + i) * 0.05;
        const r1 = 180;
        const r2 = Math.max(W, H);
        const x0 = Math.floor(cx + Math.cos(angle) * r1);
        const y0 = Math.floor(cy + Math.sin(angle) * r1);
        const x1 = Math.floor(cx + Math.cos(angle) * r2);
        const y1 = Math.floor(cy + Math.sin(angle) * r2);
        drawLine(buf, x0, y0, x1, y1, 255, 255, 255, 170, 2);
      }
    };
  }

  if (id.includes('lightning')) {
    return (buf, t) => {
      const flash = Math.sin(t * Math.PI * 6);
      if (flash > 0.4) {
        let lx = W / 2, ly = 0, count = 0;
        while (ly < H && count++ < 40) {
          const nxtX = lx + (rng() - 0.5) * 50;
          const nxtY = ly + 40 + rng() * 30;
          drawLine(buf, Math.floor(lx), Math.floor(ly), Math.floor(nxtX), Math.floor(nxtY), 140, 200, 255, 255, 3);
          lx = nxtX; ly = nxtY;
        }
      }
    };
  }

  if (id.includes('sunburst') || id.includes('summer_flare') || id.includes('spotlight')) {
    return (buf, t) => {
      const cx = W / 2, cy = 0;
      const pulse = 0.8 + 0.2 * Math.sin(t * Math.PI * 2);
      drawCircle(buf, cx, cy, 140 * pulse, 255, 210, 80, 160, true);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI + Math.sin(t * Math.PI * 2) * 0.1;
        const x1 = Math.floor(cx + Math.cos(a) * H);
        const y1 = Math.floor(cy + Math.sin(a) * H);
        drawLine(buf, cx, cy, x1, y1, 255, 220, 100, 70, 12);
      }
    };
  }

  if (id.includes('art_deco') || id.includes('corporate_grid') || id.includes('neon')) {
    const c = id.includes('neon') ? [0, 230, 255] : [240, 200, 60];
    return (buf, t) => {
      // Corner accents
      const pulse = Math.sin(t * Math.PI * 2) * 4;
      const b = 25 + pulse;
      // Top-left
      drawLine(buf, b, b, b + 60, b, c[0], c[1], c[2], 230, 3);
      drawLine(buf, b, b, b, b + 60, c[0], c[1], c[2], 230, 3);
      // Top-right
      drawLine(buf, W - b, b, W - b - 60, b, c[0], c[1], c[2], 230, 3);
      drawLine(buf, W - b, b, W - b, b + 60, c[0], c[1], c[2], 230, 3);
      // Bottom-left
      drawLine(buf, b, H - b, b + 60, H - b, c[0], c[1], c[2], 230, 3);
      drawLine(buf, b, H - b, b, H - b - 60, c[0], c[1], c[2], 230, 3);
      // Bottom-right
      drawLine(buf, W - b, H - b, W - b - 60, H - b, c[0], c[1], c[2], 230, 3);
      drawLine(buf, W - b, H - b, W - b, H - b - 60, c[0], c[1], c[2], 230, 3);
    };
  }

  // Fallback pleasant particle drift
  const P = 50;
  const parts = Array.from({ length: P }, () => ({
    x: rng() * W,
    y: rng() * H,
    rad: 4 + rng() * 6,
    vY: 1 + Math.floor(rng() * 2),
    c: isWebm ? [255, 200, 50] : [255, 180, 80]
  }));
  return (buf, t) => {
    for (const p of parts) {
      const y = (p.y + t * p.vY * H) % H;
      const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 20 + W) % W;
      drawCircle(buf, x, y, p.rad, p.c[0], p.c[1], p.c[2], 200, true);
    }
  };
}

async function renderVideo(item) {
  const isWebm = item.file.endsWith('.webm');
  const loopPath = join(LOOPS_DIR, item.file);
  const thumbPath = join(THUMBS_DIR, item.thumb);
  const renderer = createEffectRenderer(item.id, isWebm);

  // Encode video loop
  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`,
    '-r', String(FPS),
    '-i', '-'
  ];

  if (isWebm) {
    ffmpegArgs.push(
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuva420p',
      '-b:v', '0',
      '-crf', '32',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-auto-alt-ref', '0',
      loopPath
    );
  } else {
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', '24',
      loopPath
    );
  }

  const proc = spawn(FFMPEG, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffmpegErr = '';
  proc.stderr.on('data', d => { ffmpegErr += d.toString(); });

  const frameBuf = Buffer.alloc(W * H * 4);
  let thumbBuf = null;

  for (let f = 0; f < FRAMES; f++) {
    frameBuf.fill(0);
    const t = f / FRAMES;
    renderer(frameBuf, t);
    proc.stdin.write(frameBuf);

    if (f === 15) {
      thumbBuf = Buffer.from(frameBuf);
    }
  }

  proc.stdin.end();

  await new Promise((resolve, reject) => {
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegErr}`));
    });
  });

  // Extract thumbnail
  if (thumbBuf) {
    const thumbProc = spawn(FFMPEG, [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${W}x${H}`,
      '-i', '-',
      '-vf', 'scale=180:320',
      '-vframes', '1',
      thumbPath
    ], { stdio: ['pipe', 'ignore', 'ignore'] });

    thumbProc.stdin.write(thumbBuf);
    thumbProc.stdin.end();

    await new Promise(r => thumbProc.on('close', r));
  }
}

async function main() {
  const items = onlyFilter
    ? catalog.filter(c => c.id === onlyFilter || c.file.includes(onlyFilter))
    : catalog;
  if (!items.length) {
    console.error(`No effect found matching --only=${onlyFilter}`);
    process.exit(1);
  }
  console.log(`Starting generation of ${items.length} spin-fx loops (W=${W}, H=${H}, FPS=${FPS}, DURATION=${DURATION}s)...`);
  console.log(`Using FFmpeg at: ${FFMPEG}`);
  console.log(`Output directory: ${LOOPS_DIR}`);
  const startTime = Date.now();

  let count = 0;
  for (const item of items) {
    const t0 = Date.now();
    await renderVideo(item);
    const dt = Date.now() - t0;
    count++;
    const loopSize = statSync(join(LOOPS_DIR, item.file)).size;
    const thumbSize = existsSync(join(THUMBS_DIR, item.thumb)) ? statSync(join(THUMBS_DIR, item.thumb)).size : 0;
    console.log(`[${count}/${items.length}] ${item.file} (${(loopSize / 1024).toFixed(1)} KB, thumb: ${(thumbSize / 1024).toFixed(1)} KB) generated in ${dt}ms`);
  }

  const totalDt = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nSuccessfully generated ${count} loops and thumbnails in ${totalDt}s!`);

  // Optional: Copy to installed app directory if writable
  try {
    if (INSTALLED_DIR && existsSync(INSTALLED_DIR)) {
      const instLoops = join(INSTALLED_DIR, 'loops');
      const instThumbs = join(INSTALLED_DIR, 'thumbs');
      mkdirSync(instLoops, { recursive: true });
      mkdirSync(instThumbs, { recursive: true });

      for (const item of items) {
        copyFileSync(join(LOOPS_DIR, item.file), join(instLoops, item.file));
        if (existsSync(join(THUMBS_DIR, item.thumb))) {
          copyFileSync(join(THUMBS_DIR, item.thumb), join(instThumbs, item.thumb));
        }
      }
      console.log(`Copied ${count} loops and thumbnails directly into ${INSTALLED_DIR}!`);
    }
  } catch (e) {
    console.log(`Note: Installed directory copy skipped (${e.message}). The app package will include all assets.`);
  }
}

main().catch(err => {
  console.error('Fatal error in generate-spin-fx-loops:', err);
  process.exit(1);
});
