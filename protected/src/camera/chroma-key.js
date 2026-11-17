      // ---- Green screen (chroma key): the matte and the colour clean-up. ----
      // Pure maths on pixel arrays (no page, no canvas), so scripts/test-chroma-key.mjs can run it. chromaKey() in booth.src.html feeds it.
      // How one picture is keyed, in order:
      //   1. matte    how much screen colour is in the pixel, measured against the screen's own colour AND brightness, so a shadow
      //               on the cloth still keys, and white / black / skin never go see-through (the old distance test left them ~6% see-through)
      //   2. specks   small blobs left on the cloth (a bright wrinkle) are removed; long thin lines (a stray hair) are kept
      //   3. choke    faint halo (< 10%) goes, near-solid (> 92%) becomes solid
      //   4. time     live view only: blends with the last frame so the edge doesn't shimmer (fast movement is NOT blended, so no trails)
      //   5. feather  the matte is softened by about a pixel, so the cut-out has no stair-steps (thin hairs are not thinned by it)
      //   6. colour   screen spill is pulled out of the guest (hard at the edge, light further in), a little of the new background
      //               glows onto the edge, then the guest is laid over the background
      // To make the cut-out tighter or softer, change the numbers marked "tune" below.

      function ckKey(hex) {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
        const dom = g >= r && g >= b ? 1 : b >= r ? 2 : 0;           // which channel the screen is made of (green, blue or, rarely, red)
        return { cb: cb, cr: cr, kk: cb * cb + cr * cr, y: 0.299 * r + 0.587 * g + 0.114 * b, dom: dom, o1: dom === 0 ? 1 : 0, o2: dom === 2 ? 1 : 2 };
      }

      // 1. Fills a[] (one byte per pixel: 255 = guest, 0 = screen) from the pixels d[] (RGBA).
      function ckMatte(d, n, key, tol, a) {
        const kcb = key.cb, kcr = key.cr;
        if (key.kk < 500) {
          // a grey / white / black screen has no colour direction to measure along: plain distance in chroma, as before
          const soft = 26 + tol * 0.25;
          for (let i = 0, j = 0; i < n; i++, j += 4) {
            const r = d[j], g = d[j + 1], b = d[j + 2];
            const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
            const t = (Math.sqrt((cb - kcb) * (cb - kcb) + (cr - kcr) * (cr - kcr)) - tol) / soft;
            a[i] = t <= 0 ? 0 : t >= 1 ? 255 : (t * 255 + 0.5) | 0;
          }
          return;
        }
        // Strength 15..95 -> 0..1. More strength = removes paler / less certain screen colour.
        const tn = (Math.max(15, Math.min(95, tol)) - 15) / 80;
        const lo = 0.28 - 0.26 * tn,       // tune: below this much screen colour the pixel is all guest
          hi = 0.78 - 0.45 * tn,           // tune: above this much it is all screen
          qp = 1 - 0.5 * tn,               // tune: how hard a pixel of the wrong hue (skin, clothes) is protected
          inv = 1 / (hi - lo), ikk = 1 / key.kk, yk = key.y;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          const r = d[j], g = d[j + 1], b = d[j + 2];
          const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
          const u = (cb * kcb + cr * kcr) * ikk;                       // 1 = as much screen colour as the screen itself, 0 or less = none
          if (u <= 0) { a[i] = 255; continue; }
          const y = 0.299 * r + 0.587 * g + 0.114 * b;
          const sc = y < yk ? yk / (y > 45 ? y : 45) : 1;              // a shadowed cloth has less chroma: scale it back up (never scale down)
          const p = u * sc;
          if (p <= lo) { a[i] = 255; continue; }
          const pp = (cb * cb + cr * cr) * ikk - u * u;                // how far off the screen's hue (0 = same hue)
          const t = (p - qp * (pp > 0 ? Math.sqrt(pp) * sc : 0) - lo) * inv;
          a[i] = t <= 0 ? 255 : t >= 1 ? 0 : ((1 - t) * 255 + 0.5) | 0;
        }
      }

      // 2. Removes small islands of "guest" that are really cloth. Works on a coarse grid (about 200 cells wide), so it is cheap.
      // Returns that grid ({ cs: cell size in pixels, gw, gh, grid: each cell's average matte 0..255 }), which ckRun reuses to know
      // how close each pixel is to the edge of the guest.
      function ckSpecks(a, w, h) {
        const cs = Math.max(2, Math.ceil(Math.max(w, h) / 200)), gw = Math.ceil(w / cs), gh = Math.ceil(h / cs), gn = gw * gh;
        const sum = new Uint32Array(gn), bin = new Uint8Array(gn), grid = new Uint8Array(gn), out = { cs: cs, gw: gw, gh: gh, grid: grid };
        for (let y = 0; y < h; y++) {
          const row = y * w, g0 = ((y / cs) | 0) * gw;
          for (let gx = 0, x0 = 0; x0 < w; gx++, x0 += cs) {
            const xe = row + (x0 + cs < w ? x0 + cs : w);
            let s = 0;
            for (let x = row + x0; x < xe; x++) s += a[x];
            sum[g0 + gx] += s;
          }
        }
        for (let gy = 0; gy < gh; gy++) {
          const ch = Math.min(cs, h - gy * cs);
          for (let gx = 0; gx < gw; gx++) {
            const c = gy * gw + gx, m = sum[c] / (Math.min(cs, w - gx * cs) * ch);
            grid[c] = m + 0.5; bin[c] = m >= 128 ? 1 : 0;
          }
        }
        const lab = new Int32Array(gn), stack = new Int32Array(gn), sizes = [0], hairs = [false];
        let big = 0;
        for (let c0 = 0; c0 < gn; c0++) {
          if (!bin[c0] || lab[c0]) continue;
          const id = sizes.length;
          let sp = 0, size = 0, mnx = gw, mxx = 0, mny = gh, mxy = 0;
          stack[sp++] = c0; lab[c0] = id;
          while (sp) {
            const c = stack[--sp], x = c % gw, y = (c / gw) | 0;
            size++;
            if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
            if (x > 0 && bin[c - 1] && !lab[c - 1]) { lab[c - 1] = id; stack[sp++] = c - 1; }
            if (x < gw - 1 && bin[c + 1] && !lab[c + 1]) { lab[c + 1] = id; stack[sp++] = c + 1; }
            if (c >= gw && bin[c - gw] && !lab[c - gw]) { lab[c - gw] = id; stack[sp++] = c - gw; }
            if (c < gn - gw && bin[c + gw] && !lab[c + gw]) { lab[c + gw] = id; stack[sp++] = c + gw; }
          }
          sizes.push(size);
          const bw = mxx - mnx + 1, bh = mxy - mny + 1;
          hairs.push(Math.min(bw, bh) <= 2 && Math.max(bw, bh) >= 5);    // a long thin line is a stray hair (or a fold), not a blob of cloth: keep it
          if (size > big) big = size;
        }
        if (big < gn * 0.01) return out;                                // nobody in front of the cloth: nothing to protect or clean
        const maxSpeck = Math.min(gn * 0.002, big * 0.08);              // tune: islands smaller than this (of the picture, and of the guest) go
        const rem = new Uint8Array(gn);
        let any = false;
        for (let c = 0; c < gn; c++) if (lab[c] && sizes[lab[c]] < maxSpeck && !hairs[lab[c]]) { rem[c] = 1; any = true; }
        if (!any) return out;
        const rem2 = rem.slice();                                       // take the soft rim too (empty cells next to the island), never a bigger island
        for (let c = 0; c < gn; c++) {
          if (!rem[c]) continue;
          const x = c % gw, y = (c / gw) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && !bin[ny * gw + nx]) rem2[ny * gw + nx] = 1;
          }
        }
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
          if (!rem2[gy * gw + gx]) continue;
          grid[gy * gw + gx] = 0;
          const x0 = gx * cs, x1 = Math.min(w, x0 + cs), y1 = Math.min(h, gy * cs + cs);
          for (let y = gy * cs; y < y1; y++) a.fill(0, y * w + x0, y * w + x1);
        }
        return out;
      }

      // 4. Live view: blend with the previous frame's matte. Pixels that changed a lot (real movement) are taken as they are.
      function ckTime(a, st, n, now) {
        const p = st.prev;
        if (p && p.length === n && now - st.when < 400) {
          for (let i = 0; i < n; i++) {
            const df = a[i] - p[i];
            if (df > -96 && df < 96) a[i] = p[i] + df * 0.6;         // tune: 0.6 = new frame's share (lower = steadier, more lag)
            p[i] = a[i];
          }
        } else {
          st.prev = new Uint8Array(a);
        }
        st.when = now;
      }

      // 5. Box blur of a[] in place (t is scratch, same size). Radius r pixels, edges repeat.
      function ckBox(a, t, w, h, r) {
        if (r < 1) return;
        const k = 1 / (2 * r + 1);
        for (let y = 0; y < h; y++) {
          const o = y * w;
          let s = a[o] * (r + 1);
          for (let x = 1; x <= r; x++) s += a[o + (x < w ? x : w - 1)];
          for (let x = 0; x < w; x++) {
            t[o + x] = s * k + 0.5;
            s += a[o + (x + r + 1 < w ? x + r + 1 : w - 1)] - a[o + (x - r > 0 ? x - r : 0)];
          }
        }
        const col = new Int32Array(w);
        for (let x = 0; x < w; x++) col[x] = t[x] * (r + 1);
        for (let y = 1; y <= r; y++) { const o = (y < h ? y : h - 1) * w; for (let x = 0; x < w; x++) col[x] += t[o + x]; }
        for (let y = 0; y < h; y++) {
          const o = y * w, oa = (y + r + 1 < h ? y + r + 1 : h - 1) * w, os = (y - r > 0 ? y - r : 0) * w;
          for (let x = 0; x < w; x++) { a[o + x] = col[x] * k + 0.5; col[x] += t[oa + x] - t[os + x]; }
        }
      }

      // Keys the picture d (RGBA, w x h) IN PLACE over the background.
      //   bd  the background's pixels, w x h.   sm  { data, sw, sh }: the same background, small and soft (for the edge glow).
      //   o   { hex: screen colour, tol: Strength 15..95, live: true for the live view, now: ms clock (live only) }
      //   st  an object this function keeps its working memory in; use one for the live view and one for photos.
      function ckRun(d, bd, sm, w, h, o, st) {
        const n = w * h, key = ckKey(o.hex);
        if (!st.a || st.a.length !== n) { st.a = new Uint8Array(n); st.b = new Uint8Array(n); st.c = new Uint8Array(n); st.prev = null; }
        const a = st.a, t = st.b, sharp = st.c;
        ckMatte(d, n, key, o.tol, a);
        const g = ckSpecks(a, w, h);
        const c0 = 25.5, c1 = 234.6, lut = new Uint8Array(256);       // 3. choke: below 10% -> 0, above 92% -> 255, in between stretched
        for (let v = 0; v < 256; v++) { const q = (v - c0) / (c1 - c0); lut[v] = q <= 0 ? 0 : q >= 1 ? 255 : (q * 255 + 0.5) | 0; }
        for (let i = 0; i < n; i++) a[i] = lut[a[i]];
        if (o.live) ckTime(a, st, n, o.now); else st.prev = null;
        sharp.set(a);
        ckBox(a, t, w, h, Math.max(1, Math.min(3, Math.round(w / 900))));      // 5. feather ...
        for (let i = 0; i < n; i++) { const v = sharp[i] * 0.8; if (a[i] < v) a[i] = v; }   // ... but a thin hair keeps at least 80% of its own strength
        // How close each pixel is to the edge of the guest = the matte blurred wide (on the coarse grid, so it is cheap):
        // 255 deep inside the guest, 128 on a straight edge, lower in thin hair.
        const gw = g.gw, gh = g.gh, grid = g.grid, cs = g.cs;
        ckBox(grid, new Uint8Array(grid.length), gw, gh, Math.max(1, Math.round(Math.max(3, Math.min(60, w * 0.02)) / cs)));
        const cx0 = new Int32Array(w), cx1 = new Int32Array(w), ctx = new Float32Array(w);
        for (let x = 0; x < w; x++) {
          const f = Math.max(0, Math.min(gw - 1, (x + 0.5) / cs - 0.5)), i0 = f | 0;
          cx0[x] = i0; cx1[x] = i0 + 1 < gw ? i0 + 1 : i0; ctx[x] = f - i0;
        }
        const spill = key.kk >= 500, dom = key.dom, o1 = key.o1, o2 = key.o2, wrap = 0.28;     // tune: wrap = how much of the new background glows onto the edge
        const bb = sm.data, sw = sm.sw, sh = sm.sh, sxr = (sw - 1) / Math.max(1, w - 1), syr = (sh - 1) / Math.max(1, h - 1);
        for (let y = 0, i = 0; y < h; y++) {
          const fy = y * syr, y0 = fy | 0, y1 = y0 + 1 < sh ? y0 + 1 : y0, ty = fy - y0;
          const gf = Math.max(0, Math.min(gh - 1, (y + 0.5) / cs - 0.5)), gy0 = gf | 0, gy1 = gy0 + 1 < gh ? gy0 + 1 : gy0, gty = gf - gy0;
          const ro0 = gy0 * gw, ro1 = gy1 * gw;
          for (let x = 0; x < w; x++, i++) {
            const A = a[i], j = i << 2;
            if (A === 0) { d[j] = bd[j]; d[j + 1] = bd[j + 1]; d[j + 2] = bd[j + 2]; continue; }
            const tx = ctx[x], x0 = cx0[x], x1 = cx1[x];
            const ev = (grid[ro0 + x0] * (1 - tx) + grid[ro0 + x1] * tx) * (1 - gty) + (grid[ro1 + x0] * (1 - tx) + grid[ro1 + x1] * tx) * gty;
            const far = 255 - ev, ee = far >= 127.5 ? 1 : far * 2 / 255, ek = far >= 85 ? 1 : far * 3 / 255;    // ee: 0 deep inside .. 1 at the edge; ek: same, but reaches 1 sooner
            if (spill && ek > 0) {
              // Spill: the screen's channel can't be above the others. Inside the guest it is held to the stronger of the other two
              // (colours stay as they were); at the edge it is held to their average (no coloured rim).
              const p1 = d[j + o1], p2 = d[j + o2], mx = p1 > p2 ? p1 : p2, lim = mx + ((p1 + p2) * 0.5 - mx) * ek;
              if (d[j + dom] > lim) d[j + dom] = lim;
            }
            let r = d[j], gg = d[j + 1], b = d[j + 2];
            if (ee > 0.03) {
              const fx = x * sxr, bx0 = fx | 0, bx1 = bx0 + 1 < sw ? bx0 + 1 : bx0, btx = fx - bx0;
              const w00 = (1 - btx) * (1 - ty), w10 = btx * (1 - ty), w01 = (1 - btx) * ty, w11 = btx * ty;
              const i00 = (y0 * sw + bx0) << 2, i10 = (y0 * sw + bx1) << 2, i01 = (y1 * sw + bx0) << 2, i11 = (y1 * sw + bx1) << 2;
              const lw = wrap * ee * ee;
              r += (bb[i00] * w00 + bb[i10] * w10 + bb[i01] * w01 + bb[i11] * w11 - r) * lw;
              gg += (bb[i00 + 1] * w00 + bb[i10 + 1] * w10 + bb[i01 + 1] * w01 + bb[i11 + 1] * w11 - gg) * lw;
              b += (bb[i00 + 2] * w00 + bb[i10 + 2] * w10 + bb[i01 + 2] * w01 + bb[i11 + 2] * w11 - b) * lw;
            }
            if (A === 255) { d[j] = r; d[j + 1] = gg; d[j + 2] = b; continue; }
            const al = A / 255, ia = 1 - al;
            d[j] = r * al + bd[j] * ia; d[j + 1] = gg * al + bd[j + 1] * ia; d[j + 2] = b * al + bd[j + 2] * ia;
          }
        }
      }
