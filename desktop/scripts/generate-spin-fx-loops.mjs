// Procedural generator for all 40 spin-fx video loops (WebM VP9 alpha & MP4 H.264)
// and WebP thumbnails. Runs 100% locally with zero AI and zero external dependencies.
// High-fidelity 1080p rendering matching professional 360 photo booth software.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
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
  'C:\\Program Files\\photobooth4u\\resources\\app.asar.unpacked\\build\\ffmpeg\\ffmpeg.exe',
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
const FPS = 30;   // the render runs at 30 fps, so loops are made at 30 (25 would stutter)
const DURATION = 3; // 3s seamless loop for 1080p
const FRAMES = FPS * DURATION;

mkdirSync(LOOPS_DIR, { recursive: true });
mkdirSync(THUMBS_DIR, { recursive: true });

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

// Helper drawing utilities directly on Uint8Array RGBA buffer

function blendPixel(buf, idx, r, g, b, a) {
  if (a <= 0) return;
  if (a >= 255 && buf[idx + 3] === 0) {
    buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = 255;
    return;
  }
  const sa = a / 255, da = (buf[idx + 3] / 255) * (1 - sa);
  const outA = sa + da;
  if (outA > 0) {
    buf[idx] = Math.min(255, Math.floor((r * sa + buf[idx] * da) / outA));
    buf[idx + 1] = Math.min(255, Math.floor((g * sa + buf[idx + 1] * da) / outA));
    buf[idx + 2] = Math.min(255, Math.floor((b * sa + buf[idx + 2] * da) / outA));
    buf[idx + 3] = Math.min(255, Math.floor(outA * 255));
  }
}

function drawRect(buf, rx, ry, rw, rh, r, g, b, a = 255) {
  const x0 = Math.max(0, Math.floor(rx)), x1 = Math.min(W, Math.floor(rx + rw));
  const y0 = Math.max(0, Math.floor(ry)), y1 = Math.min(H, Math.floor(ry + rh));
  for (let y = y0; y < y1; y++) {
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      blendPixel(buf, row + x * 4, r, g, b, a);
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
        let alpha = a;
        if (soft) {
          const dist = Math.sqrt(dSq);
          alpha = Math.floor(a * (1 - dist / irad));
        }
        blendPixel(buf, row + x * 4, r, g, b, alpha);
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
        blendPixel(buf, (cy * W + cx) * 4, r, g, b, a);
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

// High-fidelity US 100-Dollar Bill for Cash Rain (1080p scale, 3D yaw/pitch/roll tumbling)
function drawDollarBill(buf, cx, cy, w, h, angle, pitch, roll) {
  const projH = Math.max(5, (h / 2) * Math.abs(pitch));
  const projW = Math.max(12, (w / 2) * (0.85 + 0.15 * Math.abs(roll)));
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const rad = Math.hypot(projW, projH) + 2;

  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const lx = dx * cosA + dy * sinA;
      const ly = -dx * sinA + dy * cosA;
      if (Math.abs(lx) > projW || Math.abs(ly) > projH) continue;

      const u = lx / projW;
      const v = ly / projH;
      const absU = Math.abs(u);
      const absV = Math.abs(v);

      const edgeDist = Math.min(projW - Math.abs(lx), projH - Math.abs(ly));
      const a = edgeDist < 1.0 ? Math.floor(255 * Math.max(0, edgeDist)) : 255;
      if (a <= 0) continue;

      let r = 182, g = 212, b = 188; // Banknote mint green

      if (pitch >= 0) {
        // FRONT OF $100 BILL
        if (absU > 0.94 || absV > 0.88) {
          // Outer dark intaglio border
          r = 32; g = 65; b = 40;
        } else if ((absU > 0.88 && absU <= 0.92) || (absV > 0.78 && absV <= 0.84)) {
          // Inner cream filigree border line
          r = 232; g = 244; b = 228;
        } else if (absU > 0.74 && absV > 0.60) {
          // Corner cartouches
          if (absU > 0.78 && absU < 0.88 && absV > 0.65 && absV < 0.80) {
            r = 245; g = 250; b = 240; // '100' numeral
          } else {
            r = 26; g = 54; b = 32; // cartouche background
          }
        } else if (u > 0.12 && u < 0.23) {
          // Modern 3D Holographic Security Ribbon
          r = 30; g = 110; b = 215;
          if (Math.abs(Math.sin(v * 12)) > 0.55) {
            r = 140; g = 195; b = 255; // holographic bell pattern
          }
        } else {
          // Central Portrait Vignette Oval
          const oval = (u / 0.33) * (u / 0.33) + (v / 0.72) * (v / 0.72);
          if (oval <= 1.0) {
            if (oval > 0.86) {
              r = 28; g = 58; b = 34; // oval frame border
            } else {
              const head = ((u + 0.02) / 0.20) ** 2 + ((v + 0.05) / 0.52) ** 2;
              if (head <= 1.0) {
                r = 48; g = 78; b = 58; // portrait hair/coat
                if (head < 0.35) { r = 165; g = 195; b = 175; } // face highlight
              } else {
                r = 148; g = 178; b = 158; // portrait background field
              }
            }
          } else if ((Math.floor(ly / 3) % 2) === 0) {
            r = 166; g = 196; b = 172; // fine banknote engraving lines
          }
        }
      } else {
        // BACK OF BILL (Historic US Treasury Greenback)
        if (absU > 0.92 || absV > 0.85) {
          r = 30; g = 62; b = 36;
        } else if (absU < 0.58 && absV < 0.68) {
          // Independence Hall engraving
          if (Math.abs(u) < 0.12 && v < -0.1) {
            r = 210; g = 235; b = 215; // clock tower
          } else if ((Math.floor(lx / 5) % 2) === 0) {
            r = 200; g = 225; b = 205; // architectural colonnade
          } else {
            r = 35; g = 75; b = 45;
          }
        } else {
          r = 42; g = 95; b = 54; // ornate greenback field
        }
      }

      blendPixel(buf, row + x * 4, r, g, b, a);
    }
  }
}

// Metallic party confetti piece with 3D spin and specular shine
function drawConfettiPiece(buf, cx, cy, w, h, angle, pitch, r, g, b, isMetallic = true) {
  const projH = Math.max(3, (h / 2) * Math.abs(pitch));
  const projW = w / 2;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const rad = Math.hypot(projW, projH) + 2;

  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));

  const spec = isMetallic ? Math.pow(Math.abs(pitch), 4) * 160 : 0;
  const cr = Math.min(255, Math.floor(r + spec));
  const cg = Math.min(255, Math.floor(g + spec));
  const cb = Math.min(255, Math.floor(b + spec));

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const lx = dx * cosA + dy * sinA;
      const ly = -dx * sinA + dy * cosA;
      if (Math.abs(lx) > projW || Math.abs(ly) > projH) continue;
      blendPixel(buf, row + x * 4, cr, cg, cb, 245);
    }
  }
}

// 3D Party Balloon with spherical depth, specular shine, knot, and trailing string
function drawBalloon(buf, cx, cy, rad, r, g, b, a = 240) {
  const rx = rad;
  const ry = rad * 1.18;
  const x0 = Math.max(0, Math.floor(cx - rx - 2)), x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2)), y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));

  const hlX = cx - rx * 0.35;
  const hlY = cy - ry * 0.35;
  const hlRad = rx * 0.45;

  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / ry;
    const dySq = dy * dy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dSq = dx * dx + dySq;
      if (dSq > 1.0) continue;

      const depth = Math.sqrt(1.0 - dSq);
      const hdx = x - hlX, hdy = y - hlY;
      const hDist = Math.hypot(hdx, hdy);
      const spec = Math.max(0, 1 - hDist / hlRad);
      const shine = Math.pow(spec, 3) * 190;

      const br = Math.min(255, Math.floor(r * (0.6 + depth * 0.4) + shine));
      const bg = Math.min(255, Math.floor(g * (0.6 + depth * 0.4) + shine));
      const bb = Math.min(255, Math.floor(b * (0.6 + depth * 0.4) + shine));
      const edgeAlpha = dSq > 0.9 ? Math.floor(a * (1 - dSq) / 0.1) : a;

      blendPixel(buf, row + x * 4, br, bg, bb, edgeAlpha);
    }
  }

  // Balloon knot
  const knotY = cy + ry + 4;
  const knotRad = rad * 0.12;
  const kx0 = Math.max(0, Math.floor(cx - knotRad)), kx1 = Math.min(W - 1, Math.ceil(cx + knotRad));
  const ky0 = Math.max(0, Math.floor(knotY - knotRad)), ky1 = Math.min(H - 1, Math.ceil(knotY + knotRad));
  for (let y = ky0; y <= ky1; y++) {
    const row = y * W * 4;
    for (let x = kx0; x <= kx1; x++) {
      if (Math.hypot(x - cx, y - knotY) <= knotRad) {
        blendPixel(buf, row + x * 4, Math.floor(r * 0.7), Math.floor(g * 0.7), Math.floor(b * 0.7), 240);
      }
    }
  }

  // Wavy string hanging down
  const strLen = Math.floor(rad * 2.2);
  for (let sy = 0; sy < strLen; sy++) {
    const curY = Math.floor(knotY + sy);
    if (curY >= H) break;
    const curX = Math.floor(cx + Math.sin(sy * 0.05 + cx) * 12);
    if (curX >= 0 && curX < W) {
      blendPixel(buf, (curY * W + curX) * 4, 230, 230, 240, 210);
      if (curX + 1 < W) {
        blendPixel(buf, (curY * W + curX + 1) * 4, 210, 210, 220, 160);
      }
    }
  }
}

// 3D Glossy Satin Heart
function drawGlossyHeart(buf, cx, cy, sz, r, g, b, a = 240) {
  const rad = sz * 0.65;
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad * 1.1));
  const scale = sz * 0.48;

  for (let y = y0; y <= y1; y++) {
    const ny = -(y - cy) / scale + 0.25;
    const nySq = ny * ny;
    const nyCu = nySq * ny;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / scale;
      const nxSq = nx * nx;
      const term1 = nxSq + nySq - 1;
      const heartVal = term1 * term1 * term1 - nxSq * nyCu;
      if (heartVal > 0) continue;

      // 3D glossy shine on upper-left lobe
      const hdx = nx + 0.38, hdy = ny - 0.55;
      const glint = Math.exp(-(hdx * hdx + hdy * hdy) / 0.18);
      const cr = Math.min(255, Math.floor(r + glint * 160));
      const cg = Math.min(255, Math.floor(g + glint * 140));
      const cb = Math.min(255, Math.floor(b + glint * 160));

      blendPixel(buf, row + x * 4, cr, cg, cb, a);
    }
  }
}

// Organic Rose Petal with velvety gradient and 3D fluttering
function drawRosePetal(buf, cx, cy, sz, angle, pitch, isRed = true) {
  const projH = Math.max(8, sz * Math.abs(pitch));
  const projW = sz;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const rad = Math.hypot(projW, projH) + 2;

  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const lx = (dx * cosA + dy * sinA) / projW;
      const ly = (-dx * sinA + dy * cosA) / projH;

      const r = Math.hypot(lx, ly);
      const theta = Math.atan2(ly, lx);
      const bound = 0.9 + 0.25 * Math.sin(theta) - 0.15 * Math.cos(2 * theta);
      if (r > bound) continue;

      const norm = r / bound;
      let cr = 215, cg = 25, cb = 45;
      if (isRed) {
        if (ly > 0.3) {
          cr = 135; cg = 15; cb = 28; // Deep velvety burgundy base
        } else if (norm > 0.8) {
          cr = 245; cg = 60; cb = 80; // Glowing petal rim
        }
      } else {
        cr = 255; cg = 250; cb = 245; // Ivory white petal
        if (norm > 0.8) { cr = 245; cg = 225; cb = 230; } // Blush rim
      }

      const a = norm > 0.9 ? Math.floor(240 * (1 - norm) / 0.1) : 240;
      blendPixel(buf, row + x * 4, cr, cg, cb, a);
    }
  }
}

// Prime Lens Optical Bokeh Disc with Spherical Aberration Rim
function drawBokehDisc(buf, cx, cy, rad, r, g, b, baseAlpha = 75) {
  const x0 = Math.max(0, Math.round(cx - rad)), x1 = Math.min(W - 1, Math.round(cx + rad));
  const y0 = Math.max(0, Math.round(cy - rad)), y1 = Math.min(H - 1, Math.round(cy + rad));
  const radSq = rad * rad;
  const rimThresh = 0.88;

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dSq = dx * dx + dySq;
      if (dSq > radSq) continue;

      const normDist = Math.sqrt(dSq) / rad;
      let a = baseAlpha;
      let cr = r, cg = g, cb = b;

      // Optical spherical aberration bright rim
      if (normDist > rimThresh) {
        const rimFactor = (normDist - rimThresh) / (1 - rimThresh);
        a = Math.min(255, Math.floor(baseAlpha * (1 + rimFactor * 2.8)));
        cr = Math.min(255, r + 40);
        cg = Math.min(255, g + 30);
        cb = Math.min(255, b + 40);
      } else {
        a = Math.floor(baseAlpha * (0.6 + 0.4 * (1 - normDist)));
      }

      blendPixel(buf, row + x * 4, cr, cg, cb, a);
    }
  }
}

// Liquid Champagne Bubble with refractive golden rim and specular highlight
function drawChampagneBubble(buf, cx, cy, rad) {
  const x0 = Math.max(0, Math.round(cx - rad)), x1 = Math.min(W - 1, Math.round(cx + rad));
  const y0 = Math.max(0, Math.round(cy - rad)), y1 = Math.min(H - 1, Math.round(cy + rad));
  const radSq = rad * rad;
  const glintX = cx - rad * 0.32, glintY = cy - rad * 0.32;
  const glintRadSq = (rad * 0.28) ** 2;

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dSq = dx * dx + dySq;
      if (dSq > radSq) continue;

      const norm = Math.sqrt(dSq) / rad;
      let cr = 255, cg = 225, cb = 130, a = 45;

      if (norm > 0.82) {
        const rim = (norm - 0.82) / 0.18;
        a = Math.floor(60 + rim * 175);
        cr = 255; cg = 248; cb = 190;
      }

      // Specular glint
      const gdx = x - glintX, gdy = y - glintY;
      if (gdx * gdx + gdy * gdy <= glintRadSq) {
        cr = 255; cg = 255; cb = 255; a = 255;
      }

      blendPixel(buf, row + x * 4, cr, cg, cb, a);
    }
  }
}

// 5-Point Canadian Autumn Maple Leaf
function drawMapleLeaf(buf, cx, cy, sz, angle, pitch, r, g, b, a = 230) {
  const projH = Math.max(8, sz * Math.abs(pitch));
  const projW = sz;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const rad = Math.hypot(projW, projH) + 2;

  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad));

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const lx = (dx * cosA + dy * sinA) / projW;
      const ly = (-dx * sinA + dy * cosA) / projH;

      const d = Math.hypot(lx, ly);
      if (d > 1.0) continue;
      const theta = Math.atan2(ly, lx);
      const shape = 0.55 + 0.35 * Math.cos(theta * 5) - 0.15 * Math.sin(theta);
      if (d > shape) continue;

      blendPixel(buf, row + x * 4, r, g, b, a);
    }
  }
}

// Volumetric Concert Laser Beam with Gaussian Neon Glow
function drawLaserBeam(buf, x0, y0, x1, y1, r, g, b, width = 36) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;

  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - width));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + width));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - width));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + width));

  const sigmaSq = (width * 0.38) ** 2;

  for (let y = minY; y <= maxY; y++) {
    const py = y - y0;
    const row = y * W * 4;
    for (let x = minX; x <= maxX; x++) {
      const px = x - x0;
      const proj = px * ux + py * uy;
      if (proj < 0 || proj > len) continue;

      const perp = Math.abs(px * nx + py * ny);
      if (perp > width) continue;

      const factor = Math.exp(-(perp * perp) / sigmaSq);
      let cr = r, cg = g, cb = b;
      if (perp < 4) {
        const coreFactor = 1 - perp / 4;
        cr = Math.min(255, Math.floor(r + (255 - r) * coreFactor));
        cg = Math.min(255, Math.floor(g + (255 - g) * coreFactor));
        cb = Math.min(255, Math.floor(b + (255 - b) * coreFactor));
      }

      const a = Math.floor(factor * 230);
      blendPixel(buf, row + x * 4, cr, cg, cb, a);
    }
  }
}

// Multi-point sparkling star glint
function drawStar(buf, cx, cy, rad, r, g, b, a = 255) {
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Art for the effects that used to fall back to plain circles (or were drawn crudely). Sizes are in "1080p pixels" times SC so the
// 540p loops and the 1080p loops look the same. Every motion repeats a whole number of times per loop, so the 3 s loop is seamless.
// ---------------------------------------------------------------------------------------------------------------------------------
const SC = Math.min(W, H) / 1080;
const TAU = Math.PI * 2;
const frac = (v) => v - Math.floor(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const k = clamp01((v - a) / (b - a)); return k * k * (3 - 2 * k); };
const lerp = (a, b, k) => a + (b - a) * k;

function hsv(h, s, v, out) {
  h = frac(h) * 6; const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t2 = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) { case 0: r = v; g = t2; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t2; break; case 3: r = p; g = q; b = v; break; case 4: r = t2; g = p; b = v; break; default: r = v; g = p; b = q; }
  out[0] = r * 255; out[1] = g * 255; out[2] = b * 255;
}

// Filled polygon (even-odd scanline), points are [x, y]
function fillPoly(buf, pts, r, g, b, a = 255) {
  const n = pts.length; if (n < 3 || a <= 0) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0; const yc = y + 0.5;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if ((p[1] <= yc && q[1] > yc) || (q[1] <= yc && p[1] > yc)) xs.push(p[0] + (yc - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
    }
    xs.sort((m, k) => m - k);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[i + 1] - 0.5));
      const row = y * W * 4;
      for (let x = xa; x <= xb; x++) blendPixel(buf, row + x * 4, r, g, b, a);
    }
  }
}
function polyline(buf, pts, closed, r, g, b, a, th) {
  for (let i = 0; i + 1 < pts.length; i++) drawLine(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, g, b, a, th);
  if (closed && pts.length > 2) drawLine(buf, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], r, g, b, a, th);
}
// A round glow: bright in the middle, falling off smoothly (not a flat disc)
function glow(buf, cx, cy, rad, r, g, b, a, power = 2) {
  const irad = Math.ceil(rad); if (irad <= 0 || a <= 0) return;
  const x0 = Math.max(0, Math.floor(cx) - irad), x1 = Math.min(W - 1, Math.floor(cx) + irad);
  const y0 = Math.max(0, Math.floor(cy) - irad), y1 = Math.min(H - 1, Math.floor(cy) + irad);
  for (let y = y0; y <= y1; y++) {
    const row = y * W * 4, dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, dy) / rad; if (d >= 1) continue;
      blendPixel(buf, row + x * 4, r, g, b, Math.floor(a * Math.pow(1 - d, power)));
    }
  }
}
// Shade every pixel: fn(x, y, out) fills out[0..2] with a colour and returns the alpha (0..255)
function perPixel(buf, fn) {
  const out = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) { const a = fn(x, y, out); if (a > 0.5) blendPixel(buf, row + x * 4, out[0], out[1], out[2], a > 255 ? 255 : Math.floor(a)); }
  }
}
function roundedRectPts(inset, rad, steps = 8) {
  const x0 = inset, y0 = inset, x1 = W - inset, y1 = H - inset, pts = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= steps; i++) { const a = a0 + (i / steps) * Math.PI / 2; pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); } };
  corner(x1 - rad, y0 + rad, -Math.PI / 2); corner(x1 - rad, y1 - rad, 0); corner(x0 + rad, y1 - rad, Math.PI / 2); corner(x0 + rad, y0 + rad, Math.PI);
  return pts;
}

// A jagged bolt: midpoint displacement, plus forks
function boltPoints(rngB, x0, y0, x1, y1, rough) {
  let pts = [[x0, y0], [x1, y1]];
  let amp = Math.hypot(x1 - x0, y1 - y0) * rough;
  for (let lvl = 0; lvl < 6; lvl++) {
    const next = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, off = (rngB() - 0.5) * 2 * amp;
      next.push([mx - dy / len * off, my + dx / len * off], b);
    }
    pts = next; amp *= 0.55;
  }
  return pts;
}

function drawBat(buf, x, y, s, f, r, g, b, a) {
  const P = (px, py) => [x + px * s, y + py * s];
  const wing = (m) => [[0.08, -0.12], [0.5, -0.30 - 0.30 * f], [1.0, -0.12 - 0.62 * f], [0.86, 0.16 - 0.30 * f], [0.74, 0.05 - 0.12 * f], [0.66, 0.30 - 0.14 * f],
    [0.50, 0.16 - 0.05 * f], [0.34, 0.36 - 0.03 * f], [0.20, 0.20], [0.08, 0.30]].map((p) => P(p[0] * m, p[1]));
  fillPoly(buf, wing(1), r, g, b, a); fillPoly(buf, wing(-1), r, g, b, a);
  const body = []; for (let i = 0; i < 14; i++) { const an = i / 14 * TAU; body.push(P(Math.cos(an) * 0.17, 0.02 + Math.sin(an) * 0.30)); }
  fillPoly(buf, body, r, g, b, a);
  const head = []; for (let i = 0; i < 12; i++) { const an = i / 12 * TAU; head.push(P(Math.cos(an) * 0.12, -0.34 + Math.sin(an) * 0.11)); }
  fillPoly(buf, head, r, g, b, a);
  fillPoly(buf, [P(-0.11, -0.38), P(-0.10, -0.56), P(-0.02, -0.42)], r, g, b, a);          // ears
  fillPoly(buf, [P(0.11, -0.38), P(0.10, -0.56), P(0.02, -0.42)], r, g, b, a);
  drawCircle(buf, x - 0.05 * s, y - 0.35 * s, Math.max(1.2, 0.022 * s), 255, 70, 50, a);     // glowing red eyes
  drawCircle(buf, x + 0.05 * s, y - 0.35 * s, Math.max(1.2, 0.022 * s), 255, 70, 50, a);
}
function drawGem(buf, cx, cy, R, rot, squash, t, tintSeed, glint) {
  const O = [], T = [];
  for (let i = 0; i < 8; i++) {
    const a1 = rot + i * TAU / 8, a2 = a1 + TAU / 16;
    O.push([cx + Math.cos(a1) * R * squash, cy + Math.sin(a1) * R]);
    T.push([cx + Math.cos(a2) * R * 0.5 * squash, cy + Math.sin(a2) * R * 0.5]);
  }
  const tints = [[160, 215, 255], [255, 175, 230], [170, 255, 225], [255, 235, 170], [190, 165, 255]];
  const light = TAU * 0.125 + t * TAU;      // a light that circles the gem, so the facets flash
  for (let i = 0; i < 8; i++) {
    const a1 = rot + i * TAU / 8;
    const tint = tints[(tintSeed + i) % tints.length];
    const bMain = 0.30 + 0.70 * Math.pow(0.5 + 0.5 * Math.cos(a1 + TAU / 16 - light), 2);
    fillPoly(buf, [O[i], O[(i + 1) % 8], T[i]], lerp(255, tint[0], 0.55) * bMain, lerp(255, tint[1], 0.55) * bMain, lerp(255, tint[2], 0.55) * bMain, 235);
    const bStar = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.cos(a1 + 0.8 - light), 2);
    fillPoly(buf, [T[(i + 7) % 8], T[i], O[i]], lerp(255, tint[0], 0.8) * bStar, lerp(255, tint[1], 0.8) * bStar, lerp(255, tint[2], 0.8) * bStar, 235);
  }
  fillPoly(buf, T, 225, 240, 255, 235);                                  // the flat top (table)
  polyline(buf, O, true, 255, 255, 255, 230, Math.max(1.5, 2.2 * SC));
  polyline(buf, T, true, 255, 255, 255, 170, Math.max(1, 1.6 * SC));
  for (let i = 0; i < 8; i++) drawLine(buf, O[i][0], O[i][1], T[i][0], T[i][1], 255, 255, 255, 130, Math.max(1, 1.4 * SC));
  if (glint > 0.02) {                                                    // a sparkle on one corner
    const gx = O[tintSeed % 8][0], gy = O[tintSeed % 8][1], L = R * 0.9 * glint;
    drawLine(buf, gx - L, gy, gx + L, gy, 255, 255, 255, 230 * glint, Math.max(1.5, 3 * SC));
    drawLine(buf, gx, gy - L, gx, gy + L, 255, 255, 255, 230 * glint, Math.max(1.5, 3 * SC));
    glow(buf, gx, gy, L * 0.7, 255, 255, 255, 200 * glint, 2);
  }
}
function flameTongue(buf, x, y0, w, h, lean, r, g, b, a) {
  const N = 12, Lp = [], Rp = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, hw = (w / 2) * Math.pow(1 - u, 0.85) * (1 + 0.3 * Math.sin(u * Math.PI)), cx = x + lean * u * u, yy = y0 - h * u;
    Lp.push([cx - hw, yy]); Rp.push([cx + hw, yy]);
  }
  fillPoly(buf, Lp.concat(Rp.reverse()), r, g, b, a);
}

function artRenderer(id, rng) {
  const seedOf = (k) => createRng(k * 7919 + id.length * 104729);
  // ---- Diamond Facets: tumbling cut gems that flash as a light passes over their facets
  if (id === 'diamond_prism') {
    const gems = Array.from({ length: 15 }, (_, i) => ({
      x: rng() * W, y: rng() * H, R: (52 + rng() * 62) * SC, rot: rng() * TAU, spin: 1 + Math.floor(rng() * 2) * (rng() > 0.5 ? 1 : -1),
      tilt: 1 + Math.floor(rng() * 2), ph: rng(), sway: (20 + rng() * 30) * SC, vY: 1, tint: i, gl: Math.floor(rng() * 3)
    }));
    return (buf, t) => {
      for (const g of gems) {
        const y = (g.y + t * g.vY * H) % H, x = (g.x + Math.sin(TAU * (t + g.ph)) * g.sway + W) % W;
        const squash = 0.62 + 0.38 * Math.abs(Math.cos(TAU * (t * g.tilt + g.ph)));
        const glint = Math.pow(Math.max(0, Math.sin(TAU * (t * 2 + g.ph + g.gl / 3))), 8);
        glow(buf, x, y, g.R * 1.5, 190, 220, 255, 70, 2);
        drawGem(buf, x, y, g.R, g.rot + t * TAU * g.spin * 0.5, squash, t + g.ph, g.tint, glint);
      }
    };
  }
  // ---- Spooky Bats & Mist: flapping bat silhouettes with a wing edge, flying across low mist
  if (id === 'halloween_bats') {
    const bats = Array.from({ length: 11 }, () => ({
      x: rng() * W, y: (0.08 + rng() * 0.75) * H, s: (62 + rng() * 52) * SC, vx: 1, ph: rng(), fl: 3 + Math.floor(rng() * 3), bob: (30 + rng() * 40) * SC, dir: rng() > 0.35 ? -1 : 1
    }));
    const mist = Array.from({ length: 9 }, () => ({ x: rng() * W, y: H * (0.78 + rng() * 0.22), rad: (190 + rng() * 150) * SC, v: 1 }));
    return (buf, t) => {
      for (const m of mist) { const x = (m.x + t * m.v * W) % W; glow(buf, x, m.y, m.rad, 150, 140, 170, 55, 1.3); glow(buf, x - W, m.y, m.rad, 150, 140, 170, 55, 1.3); }
      for (const b of bats) {
        const mar = b.s * 1.3, span = W + 2 * mar;
        const x = (((b.x + b.dir * t * span) % span) + span) % span - mar;
        const y = b.y + Math.sin(TAU * (t * 2 + b.ph)) * b.bob;
        const f = Math.sin(TAU * (t * b.fl * 4 + b.ph));
        drawBat(buf, x, y, b.s, f, 22, 14, 32, 252);
      }
    };
  }
  // ---- Fire & Hot Embers: flames along the bottom and glowing embers of every shade rising up the frame
  if (id === 'fire_border') {
    const tongues = Array.from({ length: 22 }, (_, i) => ({ x: (i + 0.5) / 22, k: 2 + Math.floor(rng() * 3), ph: rng(), hh: 0.15 + rng() * 0.12, k2: 1 + Math.floor(rng() * 2), ph2: rng(), row: i % 2 }));
    const embers = Array.from({ length: 110 }, () => ({ x: rng() * W, ph: rng(), vy: 1 + Math.floor(rng() * 2), sz: (3.2 + rng() * 8) * SC, sw: (14 + rng() * 40) * SC, f: 1 + Math.floor(rng() * 3), fl: 2 + Math.floor(rng() * 5) }));
    return (buf, t) => {
      const heat = 0.85 + 0.15 * Math.sin(TAU * t * 3);
      perPixel(buf, (x, y, out) => {                                          // heat glow along the bottom and up the sides
        const al = 0.34 * Math.pow(clamp01(1 - (H - y) / (H * 0.2)), 2) + 0.2 * Math.pow(clamp01(1 - Math.min(x, W - x) / (W * 0.1)), 2) * smooth(0.3, 1, y / H);
        if (al < 0.01) return 0; out[0] = 255; out[1] = 85; out[2] = 12; return 255 * al * heat;
      });
      for (const row of [0, 1]) for (const f of tongues) {
        if (f.row !== row) continue;
        const flick = 0.75 + 0.25 * Math.sin(TAU * (t * f.k + f.ph));
        const h = H * f.hh * flick * (row ? 0.75 : 1), w = (W / 22) * (row ? 2.0 : 2.5), lean = Math.sin(TAU * (t * f.k2 + f.ph2)) * w * 0.7;
        const x = W * f.x;
        flameTongue(buf, x, H + 6 * SC, w, h * 1.0, lean, 210, 35, 10, 215);
        flameTongue(buf, x, H + 6 * SC, w * 0.72, h * 0.78, lean * 0.8, 255, 125, 20, 235);
        flameTongue(buf, x, H + 6 * SC, w * 0.42, h * 0.5, lean * 0.6, 255, 225, 100, 245);
      }
      for (const e of embers) {
        const p = frac(t * e.vy + e.ph), y = H * 0.98 - p * H * 1.05, x = e.x + Math.sin(TAU * (t * e.f + e.ph)) * e.sw + p * 30 * SC;
        const life = Math.pow(1 - p, 0.9), flick = 0.6 + 0.4 * Math.sin(TAU * (t * e.fl + e.ph * 3));
        const col = p < 0.35 ? [255, lerp(225, 150, p / 0.35), lerp(110, 40, p / 0.35)] : [lerp(255, 200, (p - 0.35) / 0.65), lerp(150, 45, (p - 0.35) / 0.65), lerp(40, 15, (p - 0.35) / 0.65)];
        const a = 255 * life * flick, rad = e.sz * (1 - p * 0.55);
        glow(buf, x, y, rad * 5, col[0], col[1], col[2], a * 0.6, 2);
        drawCircle(buf, x, y, rad * 1.15, col[0], col[1], col[2], a);
        drawCircle(buf, x, y, rad * 0.45, 255, 245, 200, a);
      }
    };
  }
  // ---- Electric Lightning: branching bolts that flash, flicker and fade
  if (id === 'lightning_arcs') {
    const starts = [0.12, 0.45, 0.785];
    return (buf, t) => {
      for (let k = 0; k < 3; k++) {
        const q = frac(t - starts[k]), life = 0.13;
        if (q >= life) continue;
        const e = q / life;
        const I = Math.pow(1 - e, 1.4) * (e > 0.22 && e < 0.36 ? 0.45 : 1);           // flickers once, then dies away
        const rb = seedOf(k + 1);
        const x0 = W * (0.2 + rb() * 0.6), x1 = x0 + (rb() - 0.5) * W * 0.5, y1 = H * (0.72 + rb() * 0.28);
        const main = boltPoints(rb, x0, -10, x1, y1, 0.13);
        const segs = [main];
        for (let f = 0; f < 5; f++) {
          const at = main[Math.floor(main.length * (0.12 + rb() * 0.65))], ex = at[0] + (rb() - 0.5) * W * 0.5, ey = at[1] + H * (0.12 + rb() * 0.2);
          segs.push(boltPoints(rb, at[0], at[1], ex, ey, 0.16));
        }
        drawRect(buf, 0, 0, W, H, 150, 170, 255, Math.floor(26 * I));                    // the whole sky lights up
        for (let s = 0; s < segs.length; s++) {
          const w = s === 0 ? 1 : 0.5;
          polyline(buf, segs[s], false, 90, 110, 255, 50 * I, 42 * SC * w);
          polyline(buf, segs[s], false, 130, 190, 255, 150 * I, 16 * SC * w);
          polyline(buf, segs[s], false, 255, 255, 255, 255 * I, Math.max(2, 5.5 * SC * w));
        }
        glow(buf, x0, 0, 160 * SC, 190, 210, 255, 150 * I, 2);                          // and where it strikes
        glow(buf, x1, y1, 120 * SC, 190, 210, 255, 140 * I, 2);
      }
    };
  }
  // ---- Twinkling Galaxy: a field of stars with spikes on the big ones, nebula glow and shooting stars
  if (id === 'galaxy_stars') {
    const cols = [[255, 255, 255], [175, 205, 255], [255, 232, 175], [210, 180, 255]];
    const stars = Array.from({ length: 190 }, () => ({ x: rng() * W, y: rng() * H, r: (1.4 + Math.pow(rng(), 3) * 5.5) * SC, f: 1 + Math.floor(rng() * 3), ph: rng(), c: cols[Math.floor(rng() * cols.length)] }));
    const neb = [[0.25, 0.3, 280, [120, 60, 200]], [0.78, 0.55, 320, [50, 90, 200]], [0.4, 0.82, 260, [170, 60, 160]], [0.7, 0.12, 220, [70, 120, 220]]];
    const shoot = [{ off: 0.0, x: 0.85, y: 0.12 }, { off: 0.34, x: 0.65, y: 0.5 }, { off: 0.68, x: 0.95, y: 0.72 }];
    return (buf, t) => {
      for (const n of neb) glow(buf, n[0] * W, n[1] * H, n[2] * SC * 1.4, n[3][0], n[3][1], n[3][2], 60, 1.5);
      for (const s of stars) {
        const tw = 0.3 + 0.7 * Math.pow(Math.abs(Math.sin(TAU * (t * s.f / 2 + s.ph))), 1.5), a = 255 * tw;
        glow(buf, s.x, s.y, s.r * 3, s.c[0], s.c[1], s.c[2], a * 0.5, 2);
        drawCircle(buf, s.x, s.y, Math.max(1, s.r * 0.7), 255, 255, 255, a);
        if (s.r > 3.4 * SC) { const L = s.r * 4.5 * tw; drawLine(buf, s.x - L, s.y, s.x + L, s.y, s.c[0], s.c[1], s.c[2], a * 0.8, Math.max(1, 1.4 * SC)); drawLine(buf, s.x, s.y - L, s.x, s.y + L, s.c[0], s.c[1], s.c[2], a * 0.8, Math.max(1, 1.4 * SC)); }
      }
      for (const sh of shoot) {
        const p = frac(t + sh.off) / 0.2; if (p >= 1) continue;
        const dx = -0.8, dy = 0.6, L = 190 * SC, hx = (sh.x + dx * p * 0.5) * W, hy = (sh.y + dy * p * 0.5) * H;
        for (let i = 0; i < 14; i++) { const k = i / 14; glow(buf, hx - dx * L * k * 0.9 / 1.0 * 0.6, hy - dy * L * k * 0.9 * 0.6, (7 - 5 * k) * SC, 220, 235, 255, 230 * (1 - k) * (1 - p * 0.6), 1.5); }
        glow(buf, hx, hy, 16 * SC, 255, 255, 255, 255 * (1 - p * 0.5), 2);
      }
    };
  }
  // ---- Prism Light Leak: a rainbow light leak bleeding in from the corner and slowly sweeping
  if (id === 'prism_leak') {
    const diag = Math.hypot(W, H);
    return (buf, t) => {
      perPixel(buf, (x, y, out) => {
        const d = Math.hypot(W - x, y) / diag, m = clamp01(1 - d / 1.0);
        const d2 = Math.hypot(x, H - y) / diag, m2 = clamp01(1 - d2 / 0.75) * 0.85;
        const mask = Math.max(Math.pow(m, 0.9), Math.pow(m2, 0.9));
        if (mask < 0.01) return 0;
        const u = (x * 0.75 + y * 0.66) / diag * 1.3 - t;
        hsv(u, 0.85, 1, out);
        return 255 * mask * (0.8 + 0.2 * Math.sin(TAU * t));
      });
    };
  }
  // ---- Rainbow Strobe: a rainbow that spins round the edges and pulses on the beat
  if (id === 'rainbow_strobe') {
    const cx = W / 2, cy = H / 2, rmax = Math.hypot(cx, cy);
    return (buf, t) => {
      const beat = Math.pow(0.5 + 0.5 * Math.sin(TAU * t * 4), 3);
      perPixel(buf, (x, y, out) => {
        const r = Math.hypot(x - cx, y - cy) / rmax, edge = smooth(0.42, 1.0, r);
        if (edge < 0.01) return 0;
        hsv(Math.atan2(y - cy, x - cx) / TAU + t, 0.9, 1, out);
        return 255 * edge * (0.28 + 0.72 * beat);
      });
    };
  }
  // ---- Art Deco Geometry: golden fans in the corners and a double line frame
  if (id === 'art_deco_lines') {
    return (buf, t) => {
      const pulse = 0.72 + 0.28 * Math.sin(TAU * t), al = 235 * pulse, m = Math.min(W, H);
      const corners = [[0, 0, 0], [W, 0, Math.PI / 2], [W, H, Math.PI], [0, H, Math.PI * 1.5]];
      for (const c of corners) {
        for (let k = 1; k <= 5; k++) {
          const pts = []; for (let i = 0; i <= 18; i++) { const a = c[2] + (i / 18) * Math.PI / 2; pts.push([c[0] + Math.cos(a) * m * 0.055 * k * 1.0, c[1] + Math.sin(a) * m * 0.055 * k]); }
          polyline(buf, pts, false, 240, 200, 90, al * (k % 2 ? 1 : 0.6), (k === 5 ? 4 : 2.5) * SC);
        }
        for (let i = 0; i <= 8; i++) { const a = c[2] + (i / 8) * Math.PI / 2; drawLine(buf, c[0] + Math.cos(a) * m * 0.06, c[1] + Math.sin(a) * m * 0.06, c[0] + Math.cos(a) * m * 0.3, c[1] + Math.sin(a) * m * 0.3, 240, 200, 90, al * 0.7, 2.2 * SC); }
      }
      for (const inset of [26 * SC, 40 * SC]) polyline(buf, [[inset, inset], [W - inset, inset], [W - inset, H - inset], [inset, H - inset]], true, 240, 200, 90, al * (inset > 30 * SC ? 0.55 : 1), 2.4 * SC);
      for (const [px, py] of [[W / 2, 26 * SC], [W / 2, H - 26 * SC]]) polyline(buf, [[px - 46 * SC, py], [px, py - 22 * SC], [px + 46 * SC, py], [px, py + 22 * SC]], true, 255, 225, 120, al, 3 * SC);
    };
  }
  // ---- Hexagon Tech Grid: a honeycomb along the edges with a glow that travels round it
  if (id === 'corporate_grid') {
    const rad = 52 * SC, hw = rad * Math.sqrt(3), band = Math.min(W, H) * 0.17;
    const cells = [];
    for (let row = -1; row * rad * 1.5 < H + rad * 2; row++) for (let col = -1; col * hw < W + hw * 2; col++) {
      const cx = col * hw + (row & 1 ? hw / 2 : 0), cy = row * rad * 1.5, d = Math.min(cx, W - cx, cy, H - cy);
      if (d < band) cells.push([cx, cy, 1 - d / band]);
    }
    return (buf, t) => {
      for (const c of cells) {
        const wave = 0.5 + 0.5 * Math.sin(TAU * (t - (c[0] / W + c[1] / H) / 2)), a = 255 * (0.18 + 0.82 * wave * wave) * (0.35 + 0.65 * c[2]);
        const pts = []; for (let i = 0; i < 6; i++) { const an = Math.PI / 6 + i * TAU / 6; pts.push([c[0] + Math.cos(an) * rad * 0.94, c[1] + Math.sin(an) * rad * 0.94]); }
        polyline(buf, pts, true, 110, 195, 255, a, 2.4 * SC);
        if (wave > 0.85) fillPoly(buf, pts, 110, 195, 255, 70 * (wave - 0.85) / 0.15 * c[2]);
      }
    };
  }
  // ---- Cyberpunk Neon Frame: two glowing tubes, magenta and cyan, with a flicker
  if (id === 'neon_cyberpunk') {
    const outer = roundedRectPts(30 * SC, 56 * SC), inner = roundedRectPts(66 * SC, 36 * SC);
    return (buf, t) => {
      const fl = (0.82 + 0.18 * Math.sin(TAU * t * 3)) * (t > 0.40 && t < 0.43 ? 0.25 : 1) * (t > 0.70 && t < 0.72 ? 0.5 : 1);
      for (const [pts, c] of [[outer, [255, 40, 190]], [inner, [30, 235, 255]]]) {
        polyline(buf, pts, true, c[0], c[1], c[2], 28 * fl, 46 * SC);
        polyline(buf, pts, true, c[0], c[1], c[2], 70 * fl, 26 * SC);
        polyline(buf, pts, true, c[0], c[1], c[2], 170 * fl, 11 * SC);
        polyline(buf, pts, true, Math.min(255, c[0] + 110), Math.min(255, c[1] + 110), Math.min(255, c[2] + 110), 255 * fl, 4 * SC);
      }
    };
  }
  // ---- Stage Spotlights: two soft beams that sweep across
  if (id === 'spotlight_sweep') {
    const src = [[W * 0.12, -20, 0.35, 0.0], [W * 0.88, -20, -0.35, 0.5]];
    return (buf, t) => {
      perPixel(buf, (x, y, out) => {
        let best = 0;
        for (const s of src) {
          const dx = x - s[0], dy = y - s[1]; if (dy <= 0) continue;
          const ang = Math.atan2(dx, dy), centre = s[2] + 0.5 * Math.sin(TAU * (t + s[3]));
          const k = Math.exp(-Math.pow((ang - centre) / 0.1, 2)) * clamp01(1 - Math.hypot(dx, dy) / (H * 1.25));
          if (k > best) best = k;
        }
        if (best < 0.01) return 0;
        out[0] = 255; out[1] = 246; out[2] = 225;
        return 190 * best;
      });
    };
  }
  // ---- Summer Golden Flare: a low sun in the corner with a streak and lens ghosts
  if (id === 'summer_flare') {
    const ghosts = [[0.22, 70, [255, 150, 60]], [0.38, 46, [90, 210, 255]], [0.52, 100, [255, 110, 190]], [0.7, 58, [150, 255, 170]], [0.86, 130, [255, 200, 90]]];
    return (buf, t) => {
      const sx = W * (0.86 + 0.03 * Math.sin(TAU * t)), sy = H * (0.1 + 0.02 * Math.cos(TAU * t)), ex = W - sx, ey = H - sy;
      glow(buf, sx, sy, W * 0.62, 255, 190, 80, 190, 1.6);
      glow(buf, sx, sy, W * 0.22, 255, 235, 170, 235, 1.8);
      glow(buf, sx, sy, W * 0.07, 255, 255, 255, 255, 1.2);
      for (let k = -9; k <= 9; k++) drawRect(buf, 0, sy + k, W, 1, 255, 220, 130, Math.floor(70 * Math.exp(-k * k / 24)));
      for (const g of ghosts) glow(buf, lerp(sx, ex, g[0]), lerp(sy, ey, g[0]), g[1] * SC * 1.6, g[2][0], g[2][1], g[2][2], 120 * (0.75 + 0.25 * Math.sin(TAU * (t + g[0]))), 0.7);
    };
  }
  // ---- Vintage 8mm Film: grain, scratches, dust and projector flicker
  if (id === 'film_8mm') {
    return (buf, t, f) => {
      const r2 = createRng(f * 31337 + 17);
      drawRect(buf, 0, 0, W, H, 255, 205, 130, Math.floor(10 + r2() * 12));
      for (let i = 0; i < 1100; i++) { const x = r2() * W, y = r2() * H, a = 35 + r2() * 80; drawRect(buf, x, y, (1 + r2() * 1.5) * SC + 1, (1 + r2() * 1.5) * SC + 1, 255, 245, 225, a); }
      for (let i = 0; i < 3; i++) if (r2() > 0.35) { const x = r2() * W, y0 = r2() * H * 0.5, L = H * (0.25 + r2() * 0.5); drawLine(buf, x, y0, x + (r2() - 0.5) * 14, y0 + L, 255, 245, 225, 70 + r2() * 60, 1.3 * SC + 0.4); }
      for (let i = 0; i < 4; i++) if (r2() > 0.5) { const x = r2() * W, y = r2() * H, pts = []; for (let k = 0; k < 6; k++) pts.push([x + k * 5 * SC, y + Math.sin(k + r2() * 3) * 8 * SC]); polyline(buf, pts, false, 255, 245, 225, 110, 1.5 * SC + 0.3); }
      for (let i = 0; i < 6; i++) { const y0 = (i + 0.5) * H / 6; drawRect(buf, 6 * SC, y0, 16 * SC, 26 * SC, 255, 240, 215, 35); drawRect(buf, W - 22 * SC, y0, 16 * SC, 26 * SC, 255, 240, 215, 35); }   // sprocket holes
    };
  }
  // ---- Retro VHS Glitch: scanlines, a rolling tracking band and torn colour bars
  if (id === 'vhs_glitch') {
    return (buf, t, f) => {
      const r2 = createRng(f * 7717 + 5);
      for (let y = 0; y < H; y += Math.max(3, Math.round(4 * SC * 2))) drawRect(buf, 0, y, W, Math.max(1, Math.round(SC * 2)), 70, 70, 95, 70);
      const band = (t * 2 % 1) * (H + 160 * SC) - 80 * SC;
      drawRect(buf, 0, band, W, 46 * SC, 190, 225, 255, 70); drawRect(buf, 0, band + 46 * SC, W, 10 * SC, 255, 255, 255, 110);
      if (f % 9 < 3) for (let i = 0; i < 3; i++) { const y = r2() * H, h = (10 + r2() * 40) * SC, off = (r2() - 0.5) * 70 * SC; drawRect(buf, off, y, W, h, 0, 255, 255, 95); drawRect(buf, -off, y + 3 * SC, W, h, 255, 0, 110, 95); }
      for (let i = 0; i < 40; i++) drawRect(buf, r2() * W, r2() * H, (20 + r2() * 90) * SC, Math.max(1, SC * 2), 255, 255, 255, 80 + r2() * 90);
    };
  }
  // ---- Midnight Fireworks: rockets that burst into rings of sparks
  if (id === 'fireworks_midnight') {
    const pal = [[255, 205, 90], [255, 80, 190], [80, 225, 255], [190, 255, 150]];
    const shows = [0, 1, 2, 3].map((k) => ({ t0: k * 0.25, x: 0.2 + rng() * 0.6, y: 0.16 + rng() * 0.3, c: pal[k % pal.length], rot: rng() * TAU }));
    return (buf, t) => {
      for (const s of shows) {
        const q = frac(t - s.t0), cx = s.x * W, cy = s.y * H;
        if (q < 0.07) { const p = q / 0.07, y = lerp(H, cy, 1 - Math.pow(1 - p, 2)); for (let i = 0; i < 9; i++) glow(buf, cx + Math.sin(i + p * 9) * 3 * SC, y + i * 11 * SC, (7 - i * 0.6) * SC, 255, 220, 150, 220 * (1 - i / 9), 1.5); continue; }
        if (q > 0.4) continue;
        const p = (q - 0.07) / 0.33, a = Math.pow(1 - p, 0.8);
        for (let i = 0; i < 96; i++) {
          const an = s.rot + i / 96 * TAU + ((i * 13) % 7) * 0.02, vf = 0.38 + 0.62 * (((i * 37) % 11) / 10), d = 330 * SC * vf * (1 - Math.pow(1 - Math.min(1, p * 1.25), 2.2)) * 1.1;
          const x = cx + Math.cos(an) * d, y = cy + Math.sin(an) * d + p * p * 150 * SC * vf;
          const px = cx + Math.cos(an) * d * 0.84, py = cy + Math.sin(an) * d * 0.84 + p * p * 150 * SC * vf * 0.7;
          const c = i % 4 === 0 ? [255, 255, 255] : s.c;
          drawLine(buf, px, py, x, y, c[0], c[1], c[2], 255 * a, Math.max(2, 5 * SC));
          glow(buf, x, y, 16 * SC, c[0], c[1], c[2], 255 * a * (0.65 + 0.35 * Math.sin(i + p * 30)), 2);
        }
        glow(buf, cx, cy, 120 * SC * (1 - p), s.c[0], s.c[1], s.c[2], 120 * (1 - p), 2);
      }
    };
  }
  // ---- New Year Sparklers: gold and silver glitter falling, with sparkler fountains at the bottom
  if (id === 'nye_countdown') {
    const glitter = Array.from({ length: 80 }, () => ({ x: rng() * W, y: rng() * H, r: (5 + rng() * 11) * SC, ph: rng(), f: 1 + Math.floor(rng() * 3), vy: 1 + Math.floor(rng() * 2), c: rng() > 0.45 ? [255, 215, 90] : [225, 232, 245], sw: (15 + rng() * 30) * SC }));
    const sparks = Array.from({ length: 120 }, () => ({ x0: rng() > 0.5 ? W * 0.16 : W * 0.84, a: (rng() * 0.85 - 0.425) * Math.PI * 0.8, v: (330 + rng() * 520) * SC, life: rng(), c: rng() > 0.3 ? [255, 215, 90] : [255, 255, 255] }));
    return (buf, t) => {
      for (const g of glitter) {
        const y = (g.y + t * g.vy * H) % H, x = (g.x + Math.sin(TAU * (t * g.f + g.ph)) * g.sw + W) % W, tw = Math.pow(Math.abs(Math.sin(TAU * (t * g.f * 2 + g.ph))), 2);
        glow(buf, x, y, g.r * 2.2, g.c[0], g.c[1], g.c[2], 120 * tw, 2);
        const L = g.r * (0.5 + tw);
        drawLine(buf, x - L, y, x + L, y, g.c[0], g.c[1], g.c[2], 80 + 175 * tw, Math.max(1, 1.8 * SC)); drawLine(buf, x, y - L, x, y + L, g.c[0], g.c[1], g.c[2], 80 + 175 * tw, Math.max(1, 1.8 * SC));
      }
      for (const s of sparks) {
        const p = frac(t * 2 + s.life), d = p * s.v, x = s.x0 + Math.sin(s.a) * d, y = H * 0.97 - Math.cos(s.a) * d + p * p * 260 * SC, a = Math.floor(255 * (1 - p));
        const tl = 34 * SC * (1 - p); drawLine(buf, x - Math.sin(s.a) * tl, y + Math.cos(s.a) * tl, x, y, s.c[0], s.c[1], s.c[2], a, Math.max(1.5, 3 * SC));
        drawCircle(buf, x, y, Math.max(1.5, 3.5 * SC), 255, 255, 255, a);
      }
    };
  }
  // ---- Stage Smoke & Haze: many soft puffs drifting
  if (id === 'stage_smoke') {
    const puffs = Array.from({ length: 34 }, () => ({ x: rng() * W, y: H * (0.55 + rng() * 0.45), rad: (170 + rng() * 170) * SC, v: 1, ph: rng(), a: 26 + rng() * 22 }));
    return (buf, t) => {
      for (const p of puffs) for (const o of [0, -W]) glow(buf, (p.x + t * p.v * W) % W + o, p.y + Math.sin(TAU * (t + p.ph)) * 26 * SC, p.rad, 205, 215, 235, p.a, 1.1);
    };
  }
  // ---- Disco Ball Reflections: coloured mirror-tile spots that drift and twinkle
  if (id === 'disco_mirror') {
    const spots = Array.from({ length: 46 }, () => ({ x: rng() * W, y: rng() * H, r: (16 + rng() * 34) * SC, s: 1 + Math.floor(rng() * 2), h: rng(), f: 1 + Math.floor(rng() * 3), ph: rng() }));
    return (buf, t) => {
      for (const s of spots) {
        const y = (s.y + t * s.s * H * 0.5) % H, x = (s.x + Math.sin(TAU * (t * s.s + s.ph)) * 45 * SC + W) % W, tw = Math.pow(Math.abs(Math.sin(TAU * (t * s.f + s.ph))), 1.5);
        const c = [0, 0, 0]; hsv(s.h, 0.7, 1, c);
        glow(buf, x, y, s.r * 2.6, c[0], c[1], c[2], 170 * tw, 2);
        fillPoly(buf, [[x - s.r * 0.55, y - s.r * 0.55], [x + s.r * 0.55, y - s.r * 0.55], [x + s.r * 0.55, y + s.r * 0.55], [x - s.r * 0.55, y + s.r * 0.55]], c[0] * 0.35 + 165, c[1] * 0.35 + 165, c[2] * 0.35 + 165, 110 + 145 * tw);
      }
    };
  }
  // ---- UV Glow Dust: neon paint splatter glowing under black light
  if (id === 'blacklight_uv') {
    const cols = [[255, 60, 200], [60, 240, 255], [170, 90, 255], [170, 255, 70]];
    const dots = Array.from({ length: 95 }, () => ({ x: rng() * W, y: rng() * H, r: (3 + rng() * 11) * SC, c: cols[Math.floor(rng() * cols.length)], f: 1 + Math.floor(rng() * 3), ph: rng(), sw: (10 + rng() * 25) * SC }));
    return (buf, t) => {
      for (const d of dots) {
        const y = (d.y + t * H) % H, x = (d.x + Math.sin(TAU * (t * d.f + d.ph)) * d.sw + W) % W, tw = 0.5 + 0.5 * Math.sin(TAU * (t * d.f * 2 + d.ph));
        glow(buf, x, y, d.r * 3.4, d.c[0], d.c[1], d.c[2], 140 * (0.4 + 0.6 * tw), 2);
        drawCircle(buf, x, y, d.r, d.c[0], d.c[1], d.c[2], 255 * (0.55 + 0.45 * tw), true);
        drawCircle(buf, x, y, d.r * 0.35, 255, 255, 255, 230 * tw);
      }
    };
  }
  return null;
}

// Generate the frame data generator for each effect
function createEffectRenderer(id, isWebm) {
  const rng = createRng(id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 100));
  const art = artRenderer(id, rng);
  if (art) return art;

  // 1. CASH RAIN (Realistic 100-Dollar Bills from Money Gun)
  if (id.includes('cash_rain')) {
    const P = 26;
    const bills = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 150 + rng() * 60,  // 150px - 210px wide
      h: 68 + rng() * 26,   // 68px - 94px tall
      vY: 1 + Math.floor(rng() * 2),
      spinSpeed: 0.8 + rng() * 1.5,
      pitchSpeed: 0.7 + rng() * 1.2,
      rollSpeed: 0.5 + rng() * 1.0,
      initAngle: rng() * Math.PI * 2,
      pitchPhase: rng() * Math.PI * 2,
      rollPhase: rng() * Math.PI * 2,
      swayAmp: 30 + rng() * 30
    }));
    return (buf, t) => {
      for (const b of bills) {
        const y = (b.y + t * b.vY * H) % H;
        const x = (b.x + Math.sin(t * Math.PI * 2 * b.vY + b.y) * b.swayAmp + W) % W;
        const angle = b.initAngle + t * b.spinSpeed * Math.PI * 2;
        const pitch = Math.cos(b.pitchPhase + t * b.pitchSpeed * Math.PI * 2);
        const roll = Math.sin(b.rollPhase + t * b.rollSpeed * Math.PI * 2);
        drawDollarBill(buf, x, y, b.w, b.h, angle, pitch, roll);
      }
    };
  }

  // 2. METALLIC GOLD CONFETTI
  if (id.includes('confetti_gold')) {
    const P = 90;
    const parts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 26 + rng() * 22,   // 26px - 48px
      h: 14 + rng() * 12,   // 14px - 26px
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 4),
      angle: rng() * Math.PI * 2,
      c: rng() > 0.35 ? [255, 215, 0] : [235, 185, 45]
    }));
    return (buf, t) => {
      for (const p of parts) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 30 + W) % W;
        const pitch = Math.cos((t * p.spin + p.x) * Math.PI * 2);
        drawConfettiPiece(buf, x, y, p.w, p.h, p.angle + t * Math.PI * 2, pitch, p.c[0], p.c[1], p.c[2], true);
      }
    };
  }

  // 3. COLOR CONFETTI
  if (id.includes('confetti_multi')) {
    const P = 100;
    const colors = [
      [255, 60, 95], [40, 190, 255], [255, 220, 35],
      [65, 225, 110], [255, 135, 25], [215, 75, 255]
    ];
    const parts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      w: 24 + rng() * 20,
      h: 12 + rng() * 12,
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 4),
      angle: rng() * Math.PI * 2,
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const p of parts) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 25 + W) % W;
        const pitch = Math.cos((t * p.spin + p.x) * Math.PI * 2);
        drawConfettiPiece(buf, x, y, p.w, p.h, p.angle + t * Math.PI * 2, pitch, p.c[0], p.c[1], p.c[2], true);
      }
    };
  }

  // 4. STREAMERS & RIBBONS
  if (id.includes('streamers') || id.includes('ribbon')) {
    const P = 7;
    const colors = [
      [255, 215, 0], [255, 70, 115], [50, 210, 245],
      [180, 70, 255], [255, 150, 40], [255, 230, 110], [255, 190, 170]
    ];
    const streamers = Array.from({ length: P }, (v, i) => ({
      x0: (W / (P + 1)) * (i + 1) + (rng() - 0.5) * 60,
      period: 140 + rng() * 80,
      amp: 45 + rng() * 35,
      thick: 12 + rng() * 8, // 12px - 20px ribbon width
      c: colors[i % colors.length],
      vY: 1
    }));
    return (buf, t) => {
      for (const s of streamers) {
        const yOffset = (t * s.vY * H) % H;
        for (let y = 0; y < H; y += 4) {
          const effY = (y - yOffset + H) % H;
          const phase = (effY / s.period) * Math.PI * 2;
          const x = s.x0 + Math.sin(phase) * s.amp;
          const ribbonFacing = Math.cos(phase);
          const cr = ribbonFacing > 0 ? s.c[0] : Math.floor(s.c[0] * 0.7);
          const cg = ribbonFacing > 0 ? s.c[1] : Math.floor(s.c[1] * 0.7);
          const cb = ribbonFacing > 0 ? s.c[2] : Math.floor(s.c[2] * 0.7);
          drawCircle(buf, x, y, s.thick / 2, cr, cg, cb, 235);
        }
      }
    };
  }

  // 5. CELEBRATION BALLOONS (Large 170-280px with 3D spherical shading & wavy string)
  if (id.includes('balloons')) {
    const P = 14;
    const colors = [
      [255, 150, 165], [140, 215, 255], [195, 175, 255],
      [255, 235, 150], [255, 185, 155], [165, 245, 205]
    ];
    const balloons = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 85 + rng() * 50, // 85px - 135px radius (170-270px diameter!)
      vY: 1 + Math.floor(rng() * 2),
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const b of balloons) {
        const y = (b.y - t * b.vY * H + H * 2) % H;
        const x = (b.x + Math.sin(t * Math.PI * 2 * b.vY + b.y) * 25 + W) % W;
        drawBalloon(buf, x, y, b.rad, b.c[0], b.c[1], b.c[2], 230);
      }
    };
  }

  // 6. FLOATING HEARTS (Large 70-125px Glossy 3D Hearts)
  if (id.includes('hearts')) {
    const P = 24;
    const hearts = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 70 + rng() * 55, // 70px - 125px size!
      vY: 1 + Math.floor(rng() * 2),
      c: rng() > 0.35 ? [255, 60, 100] : [255, 120, 160]
    }));
    return (buf, t) => {
      for (const h of hearts) {
        const y = (h.y - t * h.vY * H + H * 2) % H;
        const x = (h.x + Math.sin(t * Math.PI * 2 * h.vY + h.y) * 30 + W) % W;
        drawGlossyHeart(buf, x, y, h.sz, h.c[0], h.c[1], h.c[2], 235);
      }
    };
  }

  // 7. RED ROSE PETALS & WHITE FLORAL CASCADE (Organic Teardrop 65-110px)
  if (id.includes('petals') || id.includes('rose')) {
    const P = 42;
    const isRed = id.includes('red') || id.includes('rose');
    const petals = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 65 + rng() * 45, // 65px - 110px!
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 3),
      angle: rng() * Math.PI * 2,
      swayAmp: 35 + rng() * 30
    }));
    return (buf, t) => {
      for (const p of petals) {
        const y = (p.y + t * p.vY * H) % H;
        const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * p.swayAmp + W) % W;
        const pitch = Math.cos((t * p.spin + p.x) * Math.PI * 2);
        drawRosePetal(buf, x, y, p.sz, p.angle + t * Math.PI, pitch, isRed);
      }
    };
  }

  // 8. AUTUMN MAPLE LEAVES (5-pointed 70-115px Canadian Maple Leaves)
  if (id.includes('autumn_leaves')) {
    const P = 36;
    const colors = [
      [220, 55, 25], [235, 115, 20], [195, 35, 20], [240, 175, 25]
    ];
    const leaves = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 70 + rng() * 45, // 70px - 115px!
      vY: 1 + Math.floor(rng() * 2),
      spin: 1 + Math.floor(rng() * 3),
      angle: rng() * Math.PI * 2,
      c: colors[Math.floor(rng() * colors.length)]
    }));
    return (buf, t) => {
      for (const l of leaves) {
        const y = (l.y + t * l.vY * H) % H;
        const x = (l.x + Math.sin(t * Math.PI * 2 * l.vY + l.y) * 40 + W) % W;
        const pitch = Math.cos((t * l.spin + l.x) * Math.PI * 2);
        drawMapleLeaf(buf, x, y, l.sz, l.angle + t * Math.PI, pitch, l.c[0], l.c[1], l.c[2], 230);
      }
    };
  }

  // 9. GOLDEN BOKEH RINGS (True Optical Prime Lens 180-440px Discs with Bright Aberration Rim)
  if (id.includes('bokeh')) {
    const P = 22;
    const circles = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 90 + rng() * 130, // 90px - 220px radius (180-440px diameter!)
      vY: 1,
      c: rng() > 0.3 ? [255, 205, 80] : [255, 230, 140]
    }));
    return (buf, t) => {
      for (const c of circles) {
        const y = (c.y - t * c.vY * H + H * 2) % H;
        const x = (c.x + Math.sin(t * Math.PI * 2 + c.y) * 20 + W) % W;
        drawBokehDisc(buf, x, y, c.rad, c.c[0], c.c[1], c.c[2], 80);
      }
    };
  }

  // 10. CHAMPAGNE BUBBLES (Effervescent Golden Fizz with Refractive Rim & Glint)
  if (id.includes('champagne_bubbles')) {
    const P = 70;
    const bubbles = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 10 + rng() * 32, // 10px - 42px bubble radius
      vY: 1 + Math.floor(rng() * 3)
    }));
    return (buf, t) => {
      for (const b of bubbles) {
        const y = (b.y - t * b.vY * H + H * 2) % H;
        const x = (b.x + Math.sin(t * Math.PI * 4 * b.vY + b.y) * 16 + W) % W;
        drawChampagneBubble(buf, x, y, b.rad);
      }
    };
  }

  // 11. SPARKLER FOUNTAIN & FIREWORKS & NYE COUNTDOWN
  if (id.includes('sparkler') || id.includes('fireworks') || id.includes('nye')) {
    const P = 130;
    const sparks = Array.from({ length: P }, () => ({
      x0: rng() > 0.5 ? W * 0.18 : W * 0.82,
      y0: H * 0.95,
      angle: (rng() * 0.9 - 0.45) * Math.PI,
      spd: 350 + rng() * 650,
      life: 0.4 + rng() * 0.6,
      c: rng() > 0.3 ? [255, 225, 90] : [255, 255, 255]
    }));
    return (buf, t) => {
      for (const s of sparks) {
        const progress = (t * 2 + s.life) % 1.0;
        const dist = progress * s.spd;
        const x = s.x0 + Math.sin(s.angle) * dist;
        const y = s.y0 - Math.cos(s.angle) * dist + progress * progress * 240;
        const a = Math.floor(255 * (1 - progress));
        // Burning spark trail
        const trailLen = 35 * (1 - progress);
        const tx = x - Math.sin(s.angle) * trailLen;
        const ty = y + Math.cos(s.angle) * trailLen;
        drawLine(buf, tx, ty, x, y, s.c[0], s.c[1], s.c[2], a, 3);
        drawCircle(buf, x, y, 4, 255, 255, 255, a);
      }
    };
  }

  // 12. GOLD DUST, FAIRY MAGIC, SILVER SHIMMER, BLACKLIGHT UV
  if (id.includes('gold_dust') || id.includes('fairy_dust') || id.includes('silver_shimmer') || id.includes('blacklight')) {
    const P = 100;
    const isSilver = id.includes('silver');
    const isUV = id.includes('blacklight');
    const specks = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 8 + rng() * 12,
      vY: 1,
      freq: 1 + Math.floor(rng() * 4),
      c: isUV ? [180, 80, 255] : (isSilver ? [220, 235, 255] : [255, 215, 75])
    }));
    return (buf, t) => {
      for (const s of specks) {
        const y = (s.y + t * s.vY * H) % H;
        const x = (s.x + Math.sin(t * Math.PI * 2 * s.freq + s.y) * 20 + W) % W;
        const twinkle = Math.abs(Math.sin((t * s.freq + s.x) * Math.PI * 2));
        const rad = s.rad * (0.6 + twinkle * 0.8);
        drawStar(buf, Math.floor(x), Math.floor(y), rad, s.c[0], s.c[1], s.c[2], Math.floor(220 * twinkle));
      }
    };
  }

  // 13. CLUB LASER RAYS (36-48px Wide Volumetric Laser Scan Fan with Blazing White Core)
  if (id.includes('laser_beams')) {
    const colors = [[0, 255, 140], [255, 0, 120], [0, 220, 255], [200, 40, 255]];
    return (buf, t) => {
      for (let i = 0; i < 4; i++) {
        const angle = (t * Math.PI * 2 + (i * Math.PI) / 2) % (Math.PI * 2);
        const x1 = W / 2 + Math.cos(angle) * W * 1.1;
        const y1 = H / 2 + Math.sin(angle) * H * 1.1;
        const c = colors[i % colors.length];
        drawLaserBeam(buf, W / 2, H * 0.1, x1, y1, c[0], c[1], c[2], 38);
      }
    };
  }

  // 14. WINTER SNOWSTORM (Crystalline 6-Point Snowflakes & Out-of-Focus Foreground Snow Orbs)
  if (id.includes('snow_blizzard')) {
    const P = 75;
    const flakes = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 14 + rng() * 28,
      vY: 1 + Math.floor(rng() * 2),
      drift: 30 + rng() * 40
    }));
    return (buf, t) => {
      for (const f of flakes) {
        const y = (f.y + t * f.vY * H) % H;
        const x = (f.x + Math.sin(t * Math.PI * 2 * f.vY + f.y) * f.drift + W) % W;
        // 6-point crystalline snowflake
        for (let a = 0; a < 3; a++) {
          const ang = a * (Math.PI / 3);
          const dx = Math.cos(ang) * f.rad, dy = Math.sin(ang) * f.rad;
          drawLine(buf, x - dx, y - dy, x + dx, y + dy, 245, 250, 255, 210, 2);
        }
        drawCircle(buf, x, y, f.rad * 0.35, 255, 255, 255, 230);
      }
    };
  }

  // 15. SPOOKY BATS & MIST (Anatomical Vampire Bats with 90-160px Wingspan)
  if (id.includes('halloween_bats')) {
    const P = 14;
    const bats = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      sz: 55 + rng() * 40, // 55px - 95px wing radius
      vY: 1,
      vX: 1 + Math.floor(rng() * 2)
    }));
    return (buf, t) => {
      for (const b of bats) {
        const y = (b.y + Math.sin(t * Math.PI * 4 + b.x) * 50 + H) % H;
        const x = (b.x - t * b.vX * W + W * 2) % W;
        const flap = Math.sin(t * Math.PI * 12 + b.y) * b.sz * 0.6;
        // Body
        drawCircle(buf, x, y, b.sz * 0.3, 20, 20, 25, 250);
        // Left & right wings with thickness
        drawLine(buf, x, y, x - b.sz, y - flap, 20, 20, 25, 250, 6);
        drawLine(buf, x, y, x + b.sz, y - flap, 20, 20, 25, 250, 6);
        drawLine(buf, x - b.sz, y - flap, x - b.sz * 0.6, y + flap * 0.3, 20, 20, 25, 250, 4);
        drawLine(buf, x + b.sz, y - flap, x + b.sz * 0.6, y + flap * 0.3, 20, 20, 25, 250, 4);
      }
    };
  }

  // 16. EQUALIZER WAVES (Dynamic Spectrum Analyzer Bars with Peak Caps)
  if (id.includes('audio_equalizer')) {
    const BARS = 22;
    return (buf, t) => {
      const barW = Math.floor(W / (BARS + 2));
      for (let i = 0; i < BARS; i++) {
        const phase = (t * Math.PI * 4 + (i / BARS) * Math.PI * 2);
        const h = Math.floor(60 + (Math.sin(phase) * 0.5 + 0.5) * 280);
        const x = Math.floor((i + 1) * barW);
        const y = H - h - 40;
        // Bar gradient
        drawRect(buf, x + 4, y, barW - 8, h, 0, 220, 255, 225);
        // Floating peak cap
        drawRect(buf, x + 4, y - 8, barW - 8, 4, 255, 255, 255, 255);
      }
    };
  }

  // 17. VHS GLITCH & VINTAGE 8MM FILM
  if (id.includes('vhs_glitch') || id.includes('film_8mm')) {
    return (buf, t) => {
      for (let y = 0; y < H; y += 4) {
        drawRect(buf, 0, y, W, 1, 60, 60, 80, 85);
      }
      const bandY = Math.floor((t * 3 * H) % H);
      drawRect(buf, 0, bandY, W, 20, 180, 220, 255, 110);
    };
  }

  // 18. ANIME ACTION SPEED LINES
  if (id.includes('action_speed_lines')) {
    return (buf, t) => {
      const cx = W / 2, cy = H / 2;
      for (let i = 0; i < 32; i++) {
        const baseAngle = (i / 32) * Math.PI * 2;
        const angle = baseAngle + Math.sin(t * Math.PI * 4 + i) * 0.04;
        const r1 = 240;
        const r2 = Math.max(W, H);
        const x0 = Math.floor(cx + Math.cos(angle) * r1);
        const y0 = Math.floor(cy + Math.sin(angle) * r1);
        const x1 = Math.floor(cx + Math.cos(angle) * r2);
        const y1 = Math.floor(cy + Math.sin(angle) * r2);
        drawLine(buf, x0, y0, x1, y1, 255, 255, 255, 185, 4);
      }
    };
  }

  // 19. ELECTRIC LIGHTNING
  if (id.includes('lightning')) {
    return (buf, t) => {
      const flash = Math.sin(t * Math.PI * 6);
      if (flash > 0.35) {
        let lx = W / 2, ly = 0, count = 0;
        while (ly < H && count++ < 40) {
          const nxtX = lx + (rng() - 0.5) * 80;
          const nxtY = ly + 50 + rng() * 40;
          drawLine(buf, Math.floor(lx), Math.floor(ly), Math.floor(nxtX), Math.floor(nxtY), 160, 220, 255, 255, 5);
          lx = nxtX; ly = nxtY;
        }
      }
    };
  }

  // 20. ROMANTIC SUNBURST, SUMMER FLARE, STAGE SPOTLIGHTS
  if (id.includes('sunburst') || id.includes('summer_flare') || id.includes('spotlight')) {
    return (buf, t) => {
      const cx = W / 2, cy = 0;
      const pulse = 0.85 + 0.15 * Math.sin(t * Math.PI * 2);
      drawCircle(buf, cx, cy, 220 * pulse, 255, 215, 90, 180, true);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI + Math.sin(t * Math.PI * 2) * 0.1;
        const x1 = Math.floor(cx + Math.cos(a) * H);
        const y1 = Math.floor(cy + Math.sin(a) * H);
        drawLine(buf, cx, cy, x1, y1, 255, 225, 110, 85, 24);
      }
    };
  }

  // 21. ART DECO, CORPORATE GRID, NEON CYBERPUNK
  if (id.includes('art_deco') || id.includes('corporate_grid') || id.includes('neon')) {
    const c = id.includes('neon') ? [0, 240, 255] : [245, 210, 70];
    return (buf, t) => {
      const pulse = Math.sin(t * Math.PI * 2) * 6;
      const b = 35 + pulse;
      const arm = 110;
      // Top-left
      drawLine(buf, b, b, b + arm, b, c[0], c[1], c[2], 240, 5);
      drawLine(buf, b, b, b, b + arm, c[0], c[1], c[2], 240, 5);
      // Top-right
      drawLine(buf, W - b, b, W - b - arm, b, c[0], c[1], c[2], 240, 5);
      drawLine(buf, W - b, b, W - b, b + arm, c[0], c[1], c[2], 240, 5);
      // Bottom-left
      drawLine(buf, b, H - b, b + arm, H - b, c[0], c[1], c[2], 240, 5);
      drawLine(buf, b, H - b, b, H - b - arm, c[0], c[1], c[2], 240, 5);
      // Bottom-right
      drawLine(buf, W - b, H - b, W - b - arm, H - b, c[0], c[1], c[2], 240, 5);
      drawLine(buf, W - b, H - b, W - b, H - b - arm, c[0], c[1], c[2], 240, 5);
    };
  }

  // 22. STAGE SMOKE & HAZE
  if (id.includes('stage_smoke') || id.includes('fog')) {
    const P = 20;
    const puffs = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: H * 0.7 + rng() * (H * 0.3),
      rad: 180 + rng() * 120, // 180px - 300px soft puffs
      vX: 0.5 + rng() * 0.5
    }));
    return (buf, t) => {
      for (const p of puffs) {
        const x = (p.x + t * p.vX * W) % W;
        drawCircle(buf, x, p.y, p.rad, 210, 220, 235, 60, true);
      }
    };
  }

  // 23. DISCO BALL REFLECTIONS
  if (id.includes('disco_mirror')) {
    const P = 35;
    const spots = Array.from({ length: P }, () => ({
      x: rng() * W,
      y: rng() * H,
      rad: 25 + rng() * 35,
      speed: 1 + rng() * 2
    }));
    return (buf, t) => {
      for (const s of spots) {
        const y = (s.y + t * s.speed * H * 0.5) % H;
        const x = (s.x + Math.sin(t * Math.PI * 2 * s.speed + s.y) * 45 + W) % W;
        drawCircle(buf, x, y, s.rad, 255, 255, 255, 120, true);
      }
    };
  }

  // Fallback pleasant particle drift. An effect that lands here has no art of its own and looks like generic orange circles: give it a renderer above.
  console.warn('WARNING: effect "' + id + '" has no dedicated art, drawing the generic particle fallback');
  const P = 50;
  const parts = Array.from({ length: P }, () => ({
    x: rng() * W,
    y: rng() * H,
    rad: 16 + rng() * 18,
    vY: 1 + Math.floor(rng() * 2),
    c: isWebm ? [255, 210, 60] : [255, 190, 90]
  }));
  return (buf, t) => {
    for (const p of parts) {
      const y = (p.y + t * p.vY * H) % H;
      const x = (p.x + Math.sin(t * Math.PI * 2 * p.vY + p.y) * 25 + W) % W;
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
      '-crf', isSd ? '50' : '32',
      '-deadline', isSd ? 'good' : 'realtime',
      '-cpu-used', isSd ? '2' : '4', '-row-mt', '1',
      '-auto-alt-ref', '0',
      loopPath
    );
  } else {
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-crf', isSd ? '30' : '24',
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
    renderer(frameBuf, t, f);
    // The .mp4 loops have no alpha channel: they are laid on the video with a "screen" blend, where black is see-through. The effect was
    // drawn with alpha on an empty (transparent) picture, so put it on black first. Without this every soft glow became a hard flat disc
    // and every faint wash a solid colour (the encoder just drops alpha).
    if (!isWebm) {
      for (let i = 0; i < frameBuf.length; i += 4) {
        const a = frameBuf[i + 3];
        if (a === 255) continue;
        frameBuf[i] = (frameBuf[i] * a / 255) | 0; frameBuf[i + 1] = (frameBuf[i + 1] * a / 255) | 0; frameBuf[i + 2] = (frameBuf[i + 2] * a / 255) | 0; frameBuf[i + 3] = 255;
      }
    }
    // A pipe write keeps a reference to the buffer, it does not copy it. Reusing frameBuf for the next frame before ffmpeg has
    // taken this one made every queued frame the same picture (the loop animated for a few frames, then froze = "static" effects).
    // Wait for the pipe to drain so each frame is read before frameBuf is cleared and redrawn.
    if (!proc.stdin.write(frameBuf)) await new Promise((resolve) => proc.stdin.once('drain', resolve));

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

  // Automatically sync to %APPDATA%/photobooth4u/spin-fx so the locally installed app picks up new loops instantly!
  try {
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? join(process.env.HOME, 'Library', 'Application Support') : join(process.env.HOME, '.config'));
    if (appData) {
      const userFxDir = join(appData, 'photobooth4u', 'spin-fx');
      const userLoops = isLandscape ? join(userFxDir, 'loops', 'landscape') : join(userFxDir, 'loops');
      const userThumbs = join(userFxDir, 'thumbs');
      mkdirSync(userLoops, { recursive: true });
      mkdirSync(userThumbs, { recursive: true });
      copyFileSync(CATALOG_PATH, join(userFxDir, 'catalog.json'));
      for (const item of items) {
        if (existsSync(join(LOOPS_DIR, item.file))) {
          copyFileSync(join(LOOPS_DIR, item.file), join(userLoops, item.file));
        }
        if (existsSync(join(THUMBS_DIR, item.thumb))) {
          copyFileSync(join(THUMBS_DIR, item.thumb), join(userThumbs, item.thumb));
        }
      }
      console.log(`Auto-synced ${count} loops and thumbnails to user directory: ${userFxDir}`);
    }
  } catch (e) {
    console.log(`Note: User directory sync skipped (${e.message}).`);
  }

  // Also sync to desktop/build/spin-fx for dev/prepare
  try {
    const buildFxDir = join(__dirname, '..', 'build', 'spin-fx');
    if (existsSync(join(__dirname, '..', 'build'))) {
      const bLoops = isLandscape ? join(buildFxDir, 'loops', 'landscape') : join(buildFxDir, 'loops');
      const bThumbs = join(buildFxDir, 'thumbs');
      mkdirSync(bLoops, { recursive: true });
      mkdirSync(bThumbs, { recursive: true });
      copyFileSync(CATALOG_PATH, join(buildFxDir, 'catalog.json'));
      for (const item of items) {
        if (existsSync(join(LOOPS_DIR, item.file))) {
          copyFileSync(join(LOOPS_DIR, item.file), join(bLoops, item.file));
        }
        if (existsSync(join(THUMBS_DIR, item.thumb))) {
          copyFileSync(join(THUMBS_DIR, item.thumb), join(bThumbs, item.thumb));
        }
      }
      console.log(`Synced to desktop/build/spin-fx`);
    }
  } catch (e) { }

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
    console.log(`Note: Installed directory copy skipped (${e.message}).`);
  }
}

main().catch(err => {
  console.error('Fatal error in generate-spin-fx-loops:', err);
  process.exit(1);
});
