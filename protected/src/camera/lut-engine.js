      // ---- 3D LUT (.cube) parser, packer, CPU fallback and WebGL GPU renderer ----
      // Pure maths & parsing functions work in both the browser page and Node tests (scripts/test-lut-engine.mjs).
      (function (root) {
        function lutClamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

        function lutTrilinearFloat(data, size, r, g, b, out) {
          var maxI = size - 1;
          var fr = lutClamp01(r) * maxI, fg = lutClamp01(g) * maxI, fb = lutClamp01(b) * maxI;
          var r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
          var r1 = r0 < maxI ? r0 + 1 : maxI, g1 = g0 < maxI ? g0 + 1 : maxI, b1 = b0 < maxI ? b0 + 1 : maxI;
          var dr = fr - r0, dg = fg - g0, db = fb - b0;
          var s2 = size * size;
          var i000 = (b0 * s2 + g0 * size + r0) * 3;
          var i100 = (b0 * s2 + g0 * size + r1) * 3;
          var i010 = (b0 * s2 + g1 * size + r0) * 3;
          var i110 = (b0 * s2 + g1 * size + r1) * 3;
          var i001 = (b1 * s2 + g0 * size + r0) * 3;
          var i101 = (b1 * s2 + g0 * size + r1) * 3;
          var i011 = (b1 * s2 + g1 * size + r0) * 3;
          var i111 = (b1 * s2 + g1 * size + r1) * 3;
          for (var c = 0; c < 3; c++) {
            var c00 = data[i000 + c] + (data[i100 + c] - data[i000 + c]) * dr;
            var c10 = data[i010 + c] + (data[i110 + c] - data[i010 + c]) * dr;
            var c01 = data[i001 + c] + (data[i101 + c] - data[i001 + c]) * dr;
            var c11 = data[i011 + c] + (data[i111 + c] - data[i011 + c]) * dr;
            var c0 = c00 + (c10 - c00) * dg;
            var c1 = c01 + (c11 - c01) * dg;
            out[c] = c0 + (c1 - c0) * db;
          }
          return out;
        }

        function lutSample1D(data1d, len, u, ch) {
          var maxI = len - 1;
          var f = lutClamp01(u) * maxI;
          var i0 = Math.floor(f), i1 = i0 < maxI ? i0 + 1 : maxI, t = f - i0;
          var v0 = data1d[i0 * 3 + ch], v1 = data1d[i1 * 3 + ch];
          return v0 + (v1 - v0) * t;
        }

        /**
         * Parse an Adobe/Iridas .cube LUT file (3D or 1D) and normalize to maxSize (default 33).
         * @param {string} text Raw .cube file contents
         * @param {{ maxSize?: number }} [opts]
         * @returns {{ title: string, size: number, data: Float32Array }}
         */
        function lutParseCube(text, opts) {
          if (typeof text !== 'string' || !text.trim()) throw new Error('Empty .cube file');
          var maxSize = (opts && Number(opts.maxSize)) || 33;
          var clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
          var lines = clean.split(/\r?\n/);
          var title = '', size3d = 0, size1d = 0;
          var dMin = [0, 0, 0], dMax = [1, 1, 1];
          var raw = [];

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.charCodeAt(0) === 35 /* # */) continue;
            var hashIdx = line.indexOf('#');
            if (hashIdx > 0) line = line.slice(0, hashIdx).trim();
            if (!line) continue;

            var upper = line.toUpperCase();
            if (upper.indexOf('TITLE') === 0 && (line.length === 5 || /\s/.test(line.charAt(5)))) {
              title = line.slice(5).trim().replace(/^["']|["']$/g, '');
              continue;
            }
            if (upper.indexOf('LUT_3D_SIZE') === 0) {
              size3d = parseInt(line.slice(11).trim(), 10) || 0;
              continue;
            }
            if (upper.indexOf('LUT_1D_SIZE') === 0) {
              size1d = parseInt(line.slice(11).trim(), 10) || 0;
              continue;
            }
            if (upper.indexOf('DOMAIN_MIN') === 0) {
              var mn = line.slice(10).trim().split(/\s+/);
              if (mn.length >= 3) dMin = [parseFloat(mn[0]) || 0, parseFloat(mn[1]) || 0, parseFloat(mn[2]) || 0];
              continue;
            }
            if (upper.indexOf('DOMAIN_MAX') === 0) {
              var mx = line.slice(10).trim().split(/\s+/);
              if (mx.length >= 3) dMax = [parseFloat(mx[0]), parseFloat(mx[1]), parseFloat(mx[2])];
              continue;
            }
            if (/^[A-Za-z_]/.test(line)) continue; // other metadata keywords (e.g. LUT_1D_INPUT_RANGE)

            var parts = line.split(/\s+/);
            if (parts.length >= 3) {
              var r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
              if (isFinite(r) && isFinite(g) && isFinite(b)) {
                raw.push(lutClamp01(r), lutClamp01(g), lutClamp01(b));
              }
            }
          }

          var spanR = (isFinite(dMax[0]) ? dMax[0] : 1) - dMin[0]; if (Math.abs(spanR) < 1e-6) spanR = 1;
          var spanG = (isFinite(dMax[1]) ? dMax[1] : 1) - dMin[1]; if (Math.abs(spanG) < 1e-6) spanG = 1;
          var spanB = (isFinite(dMax[2]) ? dMax[2] : 1) - dMin[2]; if (Math.abs(spanB) < 1e-6) spanB = 1;
          var needDomain = (dMin[0] !== 0 || dMin[1] !== 0 || dMin[2] !== 0 || Math.abs(spanR - 1) > 1e-5 || Math.abs(spanG - 1) > 1e-5 || Math.abs(spanB - 1) > 1e-5);

          if (size3d > 0) {
            if (size3d < 2 || size3d > 128) throw new Error('Unsupported LUT_3D_SIZE: ' + size3d);
            var needCount = size3d * size3d * size3d * 3;
            if (raw.length < needCount) throw new Error('Incomplete .cube 3D LUT data');
            var srcData = new Float32Array(raw.slice(0, needCount));
            if (size3d <= maxSize && !needDomain) {
              return { title: title, size: size3d, data: srcData };
            }
            var outSize = Math.min(size3d, maxSize);
            var outData = new Float32Array(outSize * outSize * outSize * 3);
            var tmp = [0, 0, 0], maxOut = outSize - 1, idx = 0;
            for (var bi = 0; bi < outSize; bi++) {
              var bv = needDomain ? ((bi / maxOut) - dMin[2]) / spanB : (bi / maxOut);
              for (var gi = 0; gi < outSize; gi++) {
                var gv = needDomain ? ((gi / maxOut) - dMin[1]) / spanG : (gi / maxOut);
                for (var ri = 0; ri < outSize; ri++) {
                  var rv = needDomain ? ((ri / maxOut) - dMin[0]) / spanR : (ri / maxOut);
                  lutTrilinearFloat(srcData, size3d, rv, gv, bv, tmp);
                  outData[idx++] = lutClamp01(tmp[0]);
                  outData[idx++] = lutClamp01(tmp[1]);
                  outData[idx++] = lutClamp01(tmp[2]);
                }
              }
            }
            return { title: title, size: outSize, data: outData };
          }

          if (size1d > 0) {
            if (size1d < 2 || size1d > 4096) throw new Error('Unsupported LUT_1D_SIZE: ' + size1d);
            var need1 = size1d * 3;
            if (raw.length < need1) throw new Error('Incomplete .cube 1D LUT data');
            var d1 = new Float32Array(raw.slice(0, need1));
            var n3 = Math.min(33, maxSize), maxN3 = n3 - 1;
            var cube = new Float32Array(n3 * n3 * n3 * 3), k = 0;
            for (var b3 = 0; b3 < n3; b3++) {
              var uB = needDomain ? ((b3 / maxN3) - dMin[2]) / spanB : (b3 / maxN3);
              var cB = lutClamp01(lutSample1D(d1, size1d, uB, 2));
              for (var g3 = 0; g3 < n3; g3++) {
                var uG = needDomain ? ((g3 / maxN3) - dMin[1]) / spanG : (g3 / maxN3);
                var cG = lutClamp01(lutSample1D(d1, size1d, uG, 1));
                for (var r3 = 0; r3 < n3; r3++) {
                  var uR = needDomain ? ((r3 / maxN3) - dMin[0]) / spanR : (r3 / maxN3);
                  cube[k++] = lutClamp01(lutSample1D(d1, size1d, uR, 0));
                  cube[k++] = cG;
                  cube[k++] = cB;
                }
              }
            }
            return { title: title, size: n3, data: cube };
          }

          throw new Error('Missing LUT_3D_SIZE or LUT_1D_SIZE in .cube file');
        }

        /** Pack Float32 LUT [b][g][r] into 2D RGBA image of width=size*size, height=size. */
        function lutPackRgba(lut) {
          var size = lut.size, data = lut.data;
          var w = size * size, h = size;
          var rgba = new Uint8ClampedArray(w * h * 4);
          var src = 0;
          for (var b = 0; b < size; b++) {
            for (var g = 0; g < size; g++) {
              for (var r = 0; r < size; r++) {
                var x = b * size + r;
                var dst = (g * w + x) * 4;
                rgba[dst] = Math.round(lutClamp01(data[src++]) * 255);
                rgba[dst + 1] = Math.round(lutClamp01(data[src++]) * 255);
                rgba[dst + 2] = Math.round(lutClamp01(data[src++]) * 255);
                rgba[dst + 3] = 255;
              }
            }
          }
          return { width: w, height: h, size: size, rgba: rgba };
        }

        /** Unpack 2D RGBA image (width=size*size, height=size) into flat [b][g][r]*3 Uint8Array. */
        function lutUnpackRgba(rgba, width, height) {
          var size = height;
          if (size < 2 || size > 128 || width !== size * size || !rgba || rgba.length < width * height * 4) return null;
          var bytes = new Uint8Array(size * size * size * 3);
          var u8 = (typeof Uint8ClampedArray !== 'undefined' && rgba instanceof Uint8ClampedArray)
            ? new Uint8Array(rgba.buffer, rgba.byteOffset, width * height * 4)
            : rgba;
          var dst = 0;
          for (var b = 0; b < size; b++) {
            for (var g = 0; g < size; g++) {
              for (var r = 0; r < size; r++) {
                var x = b * size + r;
                var src = (g * width + x) * 4;
                bytes[dst++] = u8[src];
                bytes[dst++] = u8[src + 1];
                bytes[dst++] = u8[src + 2];
              }
            }
          }
          return { size: size, bytes: bytes, width: width, height: height, rgba: u8 };
        }

        /** Fast CPU trilinear interpolation on 0..255 inputs/outputs with strength in 0..1. */
        function lutSampleCpu(bytes, size, r, g, b, strength, out) {
          if (!bytes || size < 2 || strength <= 0) { out[0] = r; out[1] = g; out[2] = b; return out; }
          var maxI = size - 1, scale = maxI / 255;
          var fr = (r < 0 ? 0 : r > 255 ? 255 : r) * scale;
          var fg = (g < 0 ? 0 : g > 255 ? 255 : g) * scale;
          var fb = (b < 0 ? 0 : b > 255 ? 255 : b) * scale;
          var r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
          var r1 = r0 < maxI ? r0 + 1 : maxI, g1 = g0 < maxI ? g0 + 1 : maxI, b1 = b0 < maxI ? b0 + 1 : maxI;
          var dr = fr - r0, dg = fg - g0, db = fb - b0;
          var s2 = size * size;
          var i000 = (b0 * s2 + g0 * size + r0) * 3;
          var i100 = (b0 * s2 + g0 * size + r1) * 3;
          var i010 = (b0 * s2 + g1 * size + r0) * 3;
          var i110 = (b0 * s2 + g1 * size + r1) * 3;
          var i001 = (b1 * s2 + g0 * size + r0) * 3;
          var i101 = (b1 * s2 + g0 * size + r1) * 3;
          var i011 = (b1 * s2 + g1 * size + r0) * 3;
          var i111 = (b1 * s2 + g1 * size + r1) * 3;
          var str = strength >= 1 ? 1 : strength;
          var orig = [r, g, b];
          for (var c = 0; c < 3; c++) {
            var c00 = bytes[i000 + c] + (bytes[i100 + c] - bytes[i000 + c]) * dr;
            var c10 = bytes[i010 + c] + (bytes[i110 + c] - bytes[i010 + c]) * dr;
            var c01 = bytes[i001 + c] + (bytes[i101 + c] - bytes[i001 + c]) * dr;
            var c11 = bytes[i011 + c] + (bytes[i111 + c] - bytes[i011 + c]) * dr;
            var c0 = c00 + (c10 - c00) * dg;
            var c1 = c01 + (c11 - c01) * dg;
            var lr = c0 + (c1 - c0) * db;
            out[c] = str === 1 ? lr : (orig[c] + (lr - orig[c]) * str);
          }
          return out;
        }

        /** Build pre-blended .cube text from packed LUT bytes (used for 360 Spin FFmpeg lut3d). */
        function lutToCubeText(bytes, size, strength, title) {
          var s = lutClamp01(strength == null ? 1 : strength);
          var maxI = size - 1;
          var out = [];
          if (title) out.push('TITLE "' + String(title).replace(/["\r\n]/g, '') + '"');
          out.push('LUT_3D_SIZE ' + size);
          out.push('DOMAIN_MIN 0.0 0.0 0.0');
          out.push('DOMAIN_MAX 1.0 1.0 1.0');
          var idx = 0;
          for (var b = 0; b < size; b++) {
            var ib = b / maxI;
            for (var g = 0; g < size; g++) {
              var ig = g / maxI;
              for (var r = 0; r < size; r++) {
                var ir = r / maxI;
                var lr = bytes[idx++] / 255, lg = bytes[idx++] / 255, lb = bytes[idx++] / 255;
                var rr = ir + (lr - ir) * s, gg = ig + (lg - ig) * s, bb = ib + (lb - ib) * s;
                out.push(rr.toFixed(6) + ' ' + gg.toFixed(6) + ' ' + bb.toFixed(6));
              }
            }
          }
          return out.join('\n') + '\n';
        }

        /** Build pre-blended RGBA Uint8Array (size^3 * 4) in [b][g][r] order for iOS CIColorCube. */
        function lutToCubeRgbaBytes(bytes, size, strength) {
          var s = lutClamp01(strength == null ? 1 : strength);
          var maxI = size - 1;
          var rgba = new Uint8Array(size * size * size * 4);
          var src = 0, dst = 0;
          for (var b = 0; b < size; b++) {
            var ib = (b / maxI) * 255;
            for (var g = 0; g < size; g++) {
              var ig = (g / maxI) * 255;
              for (var r = 0; r < size; r++) {
                var ir = (r / maxI) * 255;
                var lr = bytes[src++], lg = bytes[src++], lb = bytes[src++];
                rgba[dst++] = Math.round(ir + (lr - ir) * s);
                rgba[dst++] = Math.round(ig + (lg - ig) * s);
                rgba[dst++] = Math.round(ib + (lb - ib) * s);
                rgba[dst++] = 255;
              }
            }
          }
          return rgba;
        }

        function lutUint8ToBase64(u8) {
          var chunks = [], step = 0x8000;
          for (var i = 0; i < u8.length; i += step) {
            chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + step)));
          }
          return btoa(chunks.join(''));
        }

        // ---- Browser-only helpers (PNG encode/decode & WebGL 3D LUT shader) ----
        function lutToPngDataUrl(lut) {
          var packed = lutPackRgba(lut);
          var c = document.createElement('canvas');
          c.width = packed.width; c.height = packed.height;
          var ctx = c.getContext('2d');
          var im = ctx.createImageData(packed.width, packed.height);
          im.data.set(packed.rgba);
          ctx.putImageData(im, 0, 0);
          var url = c.toDataURL('image/png');
          try { c.width = 0; c.height = 0; } catch (e) { }
          return url;
        }

        function lutFromImage(img) {
          if (!img) return null;
          var w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
          if (h < 2 || w !== h * h) return null;
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          var rgba = ctx.getImageData(0, 0, w, h).data;
          try { c.width = 0; c.height = 0; } catch (e) { }
          return lutUnpackRgba(rgba, w, h);
        }

        var LUT_VS = [
          'attribute vec2 aPos;',
          'varying vec2 vUv;',
          'void main() {',
          '  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);',
          '  gl_Position = vec4(aPos, 0.0, 1.0);',
          '}'
        ].join('\n');

        var LUT_FS = [
          'precision highp float;',
          'varying vec2 vUv;',
          'uniform sampler2D uSrc;',
          'uniform sampler2D uLut;',
          'uniform float uSize;',
          'uniform float uStrength;',
          'uniform float uSoftBias;',
          'vec3 sampleSlice(float slice, float r, float g) {',
          '  float n = uSize;',
          '  float u = (slice * n + 0.5 + r * (n - 1.0)) / (n * n);',
          '  float v = (0.5 + g * (n - 1.0)) / n;',
          '  return texture2D(uLut, vec2(u, v)).rgb;',
          '}',
          'void main() {',
          '  vec4 src = texture2D(uSrc, vUv);',
          '  vec3 c = clamp(src.rgb, 0.0, 1.0);',
          '  float bScaled = c.b * (uSize - 1.0);',
          '  float b0 = floor(bScaled);',
          '  float b1 = min(uSize - 1.0, b0 + 1.0);',
          '  float bf = bScaled - b0;',
          '  vec3 l0 = sampleSlice(b0, c.r, c.g);',
          '  vec3 l1 = sampleSlice(b1, c.r, c.g);',
          '  vec3 graded = mix(c, mix(l0, l1, bf), uStrength);',
          '  if (uSoftBias > 0.0) graded = clamp(graded * 1.02 + (3.0 / 255.0), 0.0, 1.0);',
          '  gl_FragColor = vec4(graded, src.a);',
          '}'
        ].join('\n');

        function lutCreateGlRunner(canvas) {
          var state = { canvas: canvas || null, gl: null, prog: null, srcTex: null, lutTex: null, lutKey: '', broken: false };

          function init() {
            if (state.broken) return false;
            if (state.gl && !state.gl.isContextLost()) return true;
            try {
              if (!state.canvas) state.canvas = document.createElement('canvas');
              var opts = { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false };
              var gl = state.canvas.getContext('webgl', opts) || state.canvas.getContext('experimental-webgl', opts);
              if (!gl) { state.broken = true; return false; }

              var compile = function (type, src) {
                var sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
                return sh;
              };
              var vs = compile(gl.VERTEX_SHADER, LUT_VS), fs = compile(gl.FRAGMENT_SHADER, LUT_FS);
              if (!vs || !fs) { state.broken = true; return false; }
              var prog = gl.createProgram();
              gl.attachShader(prog, vs); gl.attachShader(prog, fs);
              gl.linkProgram(prog);
              if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { state.broken = true; return false; }

              var buf = gl.createBuffer();
              gl.bindBuffer(gl.ARRAY_BUFFER, buf);
              gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
              var loc = gl.getAttribLocation(prog, 'aPos');
              gl.enableVertexAttribArray(loc);
              gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

              var mkTex = function () {
                var t = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, t);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                return t;
              };

              state.gl = gl;
              state.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
              state.prog = prog;
              state.srcTex = mkTex();
              state.lutTex = mkTex();
              state.lutKey = '';
              state.uSrc = gl.getUniformLocation(prog, 'uSrc');
              state.uLut = gl.getUniformLocation(prog, 'uLut');
              state.uSize = gl.getUniformLocation(prog, 'uSize');
              state.uStrength = gl.getUniformLocation(prog, 'uStrength');
              state.uSoftBias = gl.getUniformLocation(prog, 'uSoftBias');
              state.canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); state.gl = null; state.lutKey = ''; }, false);
              return true;
            } catch (e) { state.broken = true; return false; }
          }

          return {
            canvas: function () { return state.canvas; },
            render: function (source, lutData, lutKey, strength, w, h, softBias) {
              if (!source || !lutData || !lutData.rgba || !w || !h) return false;
              if (!init()) return false;
              var gl = state.gl;
              if (w > state.maxTex || h > state.maxTex || lutData.width > state.maxTex || lutData.height > state.maxTex) return false;
              try {
                if (state.canvas.width !== w || state.canvas.height !== h) {
                  state.canvas.width = w; state.canvas.height = h;
                }
                gl.viewport(0, 0, w, h);
                gl.useProgram(state.prog);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, state.srcTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                gl.uniform1i(state.uSrc, 0);

                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, state.lutTex);
                if (state.lutKey !== lutKey) {
                  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lutData.width, lutData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData.rgba);
                  state.lutKey = lutKey;
                }
                gl.uniform1i(state.uLut, 1);

                gl.uniform1f(state.uSize, lutData.size);
                gl.uniform1f(state.uStrength, lutClamp01(strength));
                gl.uniform1f(state.uSoftBias, softBias ? 1.0 : 0.0);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                return true;
              } catch (e) {
                return false;
              }
            }
          };
        }

        var _sharedGl = null;
        function lutApplyToCanvasWebgl(c, lutData, lutKey, strength, softBias) {
          if (!c || !c.width || !c.height || !lutData) return false;
          if (!_sharedGl) _sharedGl = lutCreateGlRunner(null);
          if (!_sharedGl.render(c, lutData, lutKey, strength, c.width, c.height, softBias)) return false;
          var ctx = c.getContext('2d');
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.drawImage(_sharedGl.canvas(), 0, 0, c.width, c.height);
          ctx.restore();
          return true;
        }

        var api = {
          lutParseCube: lutParseCube,
          lutPackRgba: lutPackRgba,
          lutUnpackRgba: lutUnpackRgba,
          lutSampleCpu: lutSampleCpu,
          lutToCubeText: lutToCubeText,
          lutToCubeRgbaBytes: lutToCubeRgbaBytes,
          lutUint8ToBase64: lutUint8ToBase64,
          lutToPngDataUrl: lutToPngDataUrl,
          lutFromImage: lutFromImage,
          lutCreateGlRunner: lutCreateGlRunner,
          lutApplyToCanvasWebgl: lutApplyToCanvasWebgl
        };

        if (typeof module !== 'undefined' && module.exports) module.exports = api;
        if (root) {
          Object.keys(api).forEach(function (k) { root[k] = api[k]; });
        }
      })(typeof window !== 'undefined' ? window : null);
