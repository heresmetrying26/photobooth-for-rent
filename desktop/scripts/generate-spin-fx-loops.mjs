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
const FPS = is1080p ? 30 : 25;
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

// Generate the frame data generator for each effect
function createEffectRenderer(id, isWebm) {
  const rng = createRng(id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 100));

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

  // Fallback pleasant particle drift
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
