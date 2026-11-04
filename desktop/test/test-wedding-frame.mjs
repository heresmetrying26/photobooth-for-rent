import assert from 'node:assert';

function createMockCtx() {
  const calls = [];
  return new Proxy({ calls }, {
    get(target, prop) {
      if (prop === 'calls') return target.calls;
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: (stop, col) => target.calls.push({ stop, col }) });
      }
      return (...args) => {
        target.calls.push({ method: prop, args });
      };
    },
    set(target, prop, val) {
      target.calls.push({ set: prop, val });
      return true;
    }
  });
}

// Implement functions exactly as they will be in booth.html
function drawWeddingFloralFrame(ctx, W, H, opt) {
  opt = opt || {};
  var minDim = Math.min(W, H);
  var margin = Math.round(minDim * 0.038);
  var gap = Math.round(minDim * 0.016);
  var outerX = margin, outerY = margin, outerW = W - margin * 2, outerH = H - margin * 2;
  var innerX = margin + gap, innerY = margin + gap, innerW = W - (margin + gap) * 2, innerH = H - (margin + gap) * 2;

  ctx.save();

  var goldGradH = ctx.createLinearGradient(0, 0, W, 0);
  goldGradH.addColorStop(0.00, '#C5A059');
  goldGradH.addColorStop(0.20, '#FFF2A8');
  goldGradH.addColorStop(0.40, '#D4AF37');
  goldGradH.addColorStop(0.65, '#996515');
  goldGradH.addColorStop(0.85, '#FFF2A8');
  goldGradH.addColorStop(1.00, '#C5A059');

  var goldGradV = ctx.createLinearGradient(0, 0, 0, H);
  goldGradV.addColorStop(0.00, '#D4AF37');
  goldGradV.addColorStop(0.25, '#FFF2A8');
  goldGradV.addColorStop(0.50, '#996515');
  goldGradV.addColorStop(0.75, '#FFF2A8');
  goldGradV.addColorStop(1.00, '#D4AF37');

  ctx.shadowColor = 'rgba(212, 175, 55, 0.45)';
  ctx.shadowBlur = Math.round(minDim * 0.008);
  ctx.strokeStyle = goldGradH;
  ctx.lineWidth = Math.max(2, Math.round(minDim * 0.0025));
  ctx.strokeRect(outerX, outerY, outerW, outerH);

  ctx.strokeStyle = goldGradV;
  ctx.lineWidth = Math.max(3, Math.round(minDim * 0.0038));
  ctx.strokeRect(innerX, innerY, innerW, innerH);

  var ds = Math.max(4, Math.round(gap * 0.55));
  var corners = [
    [innerX, innerY],
    [innerX + innerW, innerY],
    [innerX, innerY + innerH],
    [innerX + innerW, innerY + innerH]
  ];
  ctx.shadowBlur = 0;
  corners.forEach(function (pt) {
    ctx.save();
    ctx.translate(pt[0], pt[1]);
    ctx.beginPath();
    ctx.moveTo(0, -ds);
    ctx.lineTo(ds, 0);
    ctx.lineTo(0, ds);
    ctx.lineTo(-ds, 0);
    ctx.closePath();
    ctx.fillStyle = '#FFF2A8';
    ctx.fill();
    ctx.strokeStyle = '#996515';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });

  function drawLeaf(lx, ly, rx, ry, ang, col) {
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-rx * 0.7, 0);
    ctx.lineTo(rx * 0.7, 0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, ry * 0.1);
    ctx.stroke();
    ctx.restore();
  }

  function drawEucalyptusSprig(startX, startY, dirX, dirY, length, leafScale) {
    ctx.save();
    var steps = 7;
    var sageTones = ['#4A6B53', '#688E71', '#8BAF91', '#A6C5AA', '#7A9E80'];
    ctx.strokeStyle = '#5E7A60';
    ctx.lineWidth = Math.max(1.5, Math.round(minDim * 0.002));
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    var endX = startX + dirX * length;
    var endY = startY + dirY * length;
    var ctrlX = startX + dirX * length * 0.5 + (-dirY) * length * 0.18;
    var ctrlY = startY + dirY * length * 0.5 + (dirX) * length * 0.18;
    ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
    ctx.stroke();

    for (var i = 1; i <= steps; i++) {
      var t = i / (steps + 1);
      var px = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * ctrlX + t * t * endX;
      var py = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * ctrlY + t * t * endY;
      var tangentAng = Math.atan2(
        2 * (1 - t) * (ctrlY - startY) + 2 * t * (endY - ctrlY),
        2 * (1 - t) * (ctrlX - startX) + 2 * t * (endX - ctrlX)
      );
      var lSize = (0.6 + 0.4 * Math.sin(t * Math.PI)) * leafScale;
      var colL = sageTones[i % sageTones.length];
      var colR = sageTones[(i + 2) % sageTones.length];
      drawLeaf(px, py, lSize, lSize * 0.58, tangentAng + 0.7, colL);
      drawLeaf(px, py, lSize * 0.95, lSize * 0.55, tangentAng - 0.7, colR);
    }
    ctx.restore();
  }

  function drawGoldenBerries(bx, by, ang, length) {
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang);
    ctx.strokeStyle = '#B38728';
    ctx.lineWidth = Math.max(1.2, minDim * 0.0018);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length, 0);
    ctx.stroke();
    var berryCount = 4;
    for (var b = 1; b <= berryCount; b++) {
      var dist = (b / (berryCount + 1)) * length;
      var side = (b % 2 === 0 ? 1 : -1) * (minDim * 0.009);
      ctx.beginPath();
      ctx.moveTo(dist, 0);
      ctx.lineTo(dist + minDim * 0.004, side);
      ctx.stroke();
      var br = Math.max(3, Math.round(minDim * 0.007));
      var bGrad = ctx.createRadialGradient(dist + minDim * 0.002, side - br * 0.3, br * 0.1, dist + minDim * 0.004, side, br);
      bGrad.addColorStop(0, '#FFFFFF');
      bGrad.addColorStop(0.3, '#FFF2A8');
      bGrad.addColorStop(0.7, '#D4AF37');
      bGrad.addColorStop(1.0, '#996515');
      ctx.fillStyle = bGrad;
      ctx.beginPath();
      ctx.arc(dist + minDim * 0.004, side, br, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawWatercolorRose(cx, cy, radius, baseType) {
    ctx.save();
    ctx.translate(cx, cy);
    var isPeach = baseType === 'peach';
    var outerCols = isPeach ? ['#FBE2D5', '#FAD5C0', '#FCE5D8', '#F9C9B0'] : ['#FCE4EC', '#F8BBD0', '#FEEBF0', '#F5A9BC'];
    var midCols = isPeach ? ['#F8B195', '#F59E7C', '#F7B797', '#EE886E'] : ['#F48FB1', '#EC407A', '#F06292', '#E91E63'];
    var innerCols = isPeach ? ['#EE7354', '#D95338', '#E65100', '#BF360C'] : ['#D81B60', '#C2185B', '#AD1457', '#880E4F'];

    for (var p1 = 0; p1 < 7; p1++) {
      var a1 = (p1 / 7) * Math.PI * 2;
      var dist1 = radius * 0.65;
      var px1 = Math.cos(a1) * dist1, py1 = Math.sin(a1) * dist1;
      ctx.save();
      ctx.translate(px1, py1);
      ctx.rotate(a1 + Math.PI / 2);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.52, radius * 0.38, 0, 0, Math.PI * 2);
      ctx.fillStyle = outerCols[p1 % outerCols.length];
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.restore();
    }

    for (var p2 = 0; p2 < 6; p2++) {
      var a2 = (p2 / 6) * Math.PI * 2 + 0.4;
      var dist2 = radius * 0.42;
      var px2 = Math.cos(a2) * dist2, py2 = Math.sin(a2) * dist2;
      ctx.save();
      ctx.translate(px2, py2);
      ctx.rotate(a2 + Math.PI / 2);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.40, radius * 0.28, 0, 0, Math.PI * 2);
      ctx.fillStyle = midCols[p2 % midCols.length];
      ctx.globalAlpha = 0.90;
      ctx.fill();
      ctx.restore();
    }

    for (var p3 = 0; p3 < 5; p3++) {
      var a3 = (p3 / 5) * Math.PI * 2 + 0.8;
      var dist3 = radius * 0.22;
      var px3 = Math.cos(a3) * dist3, py3 = Math.sin(a3) * dist3;
      ctx.save();
      ctx.translate(px3, py3);
      ctx.rotate(a3 + Math.PI / 2);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.25, radius * 0.18, 0, 0, Math.PI * 2);
      ctx.fillStyle = innerCols[p3 % innerCols.length];
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;
    for (var s = 0; s < 7; s++) {
      var sa = (s / 7) * Math.PI * 2;
      var sr = radius * 0.10;
      ctx.beginPath();
      ctx.arc(Math.cos(sa) * sr, Math.sin(sa) * sr, Math.max(1.5, radius * 0.04), 0, Math.PI * 2);
      ctx.fillStyle = '#FFF2A8';
      ctx.fill();
    }
    ctx.restore();
  }

  var trX = W - margin, trY = margin;
  drawEucalyptusSprig(trX - minDim * 0.04, trY + minDim * 0.02, -1, 0.2, minDim * 0.32, minDim * 0.038);
  drawEucalyptusSprig(trX - minDim * 0.02, trY + minDim * 0.04, -0.2, 1, minDim * 0.32, minDim * 0.038);
  drawEucalyptusSprig(trX - minDim * 0.06, trY + minDim * 0.06, -0.7, 0.7, minDim * 0.22, minDim * 0.032);
  drawGoldenBerries(trX - minDim * 0.08, trY + minDim * 0.03, -Math.PI * 0.95, minDim * 0.18);
  drawGoldenBerries(trX - minDim * 0.03, trY + minDim * 0.08, Math.PI * 0.45, minDim * 0.18);
  drawWatercolorRose(trX - minDim * 0.05, trY + minDim * 0.06, minDim * 0.088, 'peach');
  drawWatercolorRose(trX - minDim * 0.14, trY + minDim * 0.03, minDim * 0.068, 'blush');
  drawWatercolorRose(trX - minDim * 0.03, trY + minDim * 0.14, minDim * 0.052, 'peach');

  var blX = margin, blY = H - margin;
  drawEucalyptusSprig(blX + minDim * 0.04, blY - minDim * 0.02, 1, -0.2, minDim * 0.30, minDim * 0.036);
  drawEucalyptusSprig(blX + minDim * 0.02, blY - minDim * 0.04, 0.2, -1, minDim * 0.30, minDim * 0.036);
  drawGoldenBerries(blX + minDim * 0.08, blY - minDim * 0.03, -0.15, minDim * 0.18);
  drawGoldenBerries(blX + minDim * 0.03, blY - minDim * 0.08, -Math.PI * 0.55, minDim * 0.18);
  drawWatercolorRose(blX + minDim * 0.06, blY - minDim * 0.06, minDim * 0.082, 'blush');
  drawWatercolorRose(blX + minDim * 0.14, blY - minDim * 0.03, minDim * 0.065, 'peach');
  drawWatercolorRose(blX + minDim * 0.03, blY - minDim * 0.14, minDim * 0.048, 'blush');

  var tlX = margin, tlY = margin;
  drawEucalyptusSprig(tlX + minDim * 0.02, tlY + minDim * 0.02, 0.8, 0.6, minDim * 0.22, minDim * 0.032);
  drawWatercolorRose(tlX + minDim * 0.05, tlY + minDim * 0.05, minDim * 0.052, 'blush');

  var brX = W - margin, brY = H - margin;
  drawEucalyptusSprig(brX - minDim * 0.02, brY - minDim * 0.02, -0.8, -0.6, minDim * 0.22, minDim * 0.032);
  drawGoldenBerries(brX - minDim * 0.05, brY - minDim * 0.04, -Math.PI * 0.8, minDim * 0.15);
  drawWatercolorRose(brX - minDim * 0.05, brY - minDim * 0.05, minDim * 0.046, 'peach');

  var t1 = (opt.text1 != null && String(opt.text1).trim() !== '') ? String(opt.text1).trim() : '';
  var t2 = (opt.text2 != null && String(opt.text2).trim() !== '') ? String(opt.text2).trim() : '';
  if (!t1 && !t2 && (!opt.textOn)) {
    t1 = 'Yustina & George';
    t2 = '07.31.2026';
  }

  if (t1) {
    ctx.save();
    var scriptFont = '"Alex Brush", "Pinyon Script", "Great Vibes", "Brush Script MT", "Segoe Script", "Apple Chancery", cursive';
    var nameSize = Math.max(24, Math.round(minDim * 0.068));
    ctx.font = 'italic 700 ' + nameSize + 'px ' + scriptFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    var nameParts = [];
    if (t1.includes(' & ')) {
      var sp = t1.split(' & ');
      nameParts = [sp[0], '& ' + sp.slice(1).join(' & ')];
    } else if (t1.includes(' and ')) {
      var sp2 = t1.split(' and ');
      nameParts = [sp2[0], '& ' + sp2.slice(1).join(' and ')];
    } else {
      nameParts = [t1];
    }

    var textBaseX = Math.round(innerX + minDim * 0.02);
    var textBaseY = Math.round(innerY + innerH - minDim * 0.025);
    var lineH = Math.round(nameSize * 0.95);

    nameParts.reverse().forEach(function (part, idx) {
      var py = textBaseY - idx * lineH;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = Math.round(nameSize * 0.25);
      ctx.shadowOffsetX = Math.round(nameSize * 0.04);
      ctx.shadowOffsetY = Math.round(nameSize * 0.04);
      ctx.strokeStyle = '#AA771C';
      ctx.lineWidth = Math.max(3, Math.round(nameSize * 0.08));
      ctx.strokeText(part, textBaseX, py);
      ctx.fillStyle = '#FFFDF5';
      ctx.fillText(part, textBaseX, py);
    });
    ctx.restore();
  }

  if (t2) {
    ctx.save();
    var serifFont = '"Cinzel", "Playfair Display", "Didot", "Bodoni MT", Georgia, serif';
    var dateSize = Math.max(14, Math.round(minDim * 0.030));
    ctx.font = '300 ' + dateSize + 'px ' + serifFont;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    var dateX = Math.round(innerX + innerW - minDim * 0.02);
    var dateY = Math.round(innerY + innerH - minDim * 0.028);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = Math.round(dateSize * 0.3);
    ctx.shadowOffsetX = Math.round(dateSize * 0.05);
    ctx.shadowOffsetY = Math.round(dateSize * 0.05);
    ctx.strokeStyle = '#AA771C';
    ctx.lineWidth = Math.max(2, Math.round(dateSize * 0.06));
    ctx.strokeText(t2, dateX, dateY);
    ctx.fillStyle = '#FBF0B9';
    ctx.fillText(t2, dateX, dateY);
    ctx.restore();
  }

  ctx.restore();
}

const mock = createMockCtx();
drawWeddingFloralFrame(mock, 1080, 1920, { text1: 'Yustina & George', text2: '07.31.2022' });
console.log('Executed drawWeddingFloralFrame successfully! Total canvas calls:', mock.calls.length);
assert(mock.calls.length > 100, 'Expected extensive canvas operations');

function drawArtDecoGalaFrame(ctx, W, H, opt) {
  opt = opt || {};
  var minDim = Math.min(W, H);
  var margin = Math.round(minDim * 0.04);
  var gap = Math.round(minDim * 0.018);
  ctx.save();

  var goldGrad = ctx.createLinearGradient(0, 0, W, H);
  goldGrad.addColorStop(0.0, '#D4AF37');
  goldGrad.addColorStop(0.25, '#FFF2A8');
  goldGrad.addColorStop(0.5, '#AA771C');
  goldGrad.addColorStop(0.75, '#FFF2A8');
  goldGrad.addColorStop(1.0, '#D4AF37');

  ctx.strokeStyle = goldGrad;
  ctx.shadowColor = 'rgba(212, 175, 55, 0.5)';
  ctx.shadowBlur = Math.round(minDim * 0.01);

  [0, gap * 0.6, gap * 1.4].forEach(function (offset, idx) {
    ctx.lineWidth = idx === 1 ? Math.max(3, Math.round(minDim * 0.004)) : Math.max(1.5, Math.round(minDim * 0.002));
    var x = margin + offset, y = margin + offset, w = W - (margin + offset) * 2, h = H - (margin + offset) * 2;
    ctx.strokeRect(x, y, w, h);
  });

  var cSize = Math.round(gap * 2.8);
  var corners = [
    [margin, margin, 1, 1],
    [W - margin, margin, -1, 1],
    [margin, H - margin, 1, -1],
    [W - margin, H - margin, -1, -1]
  ];
  corners.forEach(function (c) {
    var cx = c[0], cy = c[1], dx = c[2], dy = c[3];
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * cSize);
    ctx.lineTo(cx + dx * cSize, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + dx * (cSize * 0.4), cy);
    ctx.lineTo(cx, cy + dy * (cSize * 0.4));
    ctx.stroke();
    ctx.beginPath();
    var dm = cSize * 0.25;
    ctx.moveTo(cx + dx * dm, cy);
    ctx.lineTo(cx, cy + dy * dm);
    ctx.lineTo(cx - dx * (dm * 0.3), cy);
    ctx.lineTo(cx, cy - dy * (dm * 0.3));
    ctx.fillStyle = '#FFF2A8';
    ctx.fill();
  });

  var t1 = (opt.text1 != null && String(opt.text1).trim() !== '') ? String(opt.text1).trim() : '';
  var t2 = (opt.text2 != null && String(opt.text2).trim() !== '') ? String(opt.text2).trim() : '';
  if (t1) {
    ctx.save();
    var titleSize = Math.max(22, Math.round(minDim * 0.05));
    ctx.font = '700 ' + titleSize + 'px "Cinzel", "Playfair Display", "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFF2A8';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = Math.round(titleSize * 0.3);
    ctx.fillText(t1.toUpperCase(), W / 2, H - margin - Math.round(gap * 2.2));
    if (t2) {
      ctx.font = '400 ' + Math.round(titleSize * 0.55) + 'px "Cinzel", "Playfair Display", serif';
      ctx.fillStyle = '#E5C07B';
      ctx.fillText(t2, W / 2, H - margin - Math.round(gap * 0.8));
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawNeonCyberpunkFrame(ctx, W, H, opt) {
  opt = opt || {};
  var minDim = Math.min(W, H);
  var margin = Math.round(minDim * 0.038);
  var gap = Math.round(minDim * 0.015);
  ctx.save();

  var x1 = margin, y1 = margin, w1 = W - margin * 2, h1 = H - margin * 2;
  var x2 = margin + gap, y2 = margin + gap, w2 = W - (margin + gap) * 2, h2 = H - (margin + gap) * 2;

  ctx.shadowColor = '#00F0FF';
  ctx.shadowBlur = Math.round(minDim * 0.02);
  ctx.strokeStyle = '#00F0FF';
  ctx.lineWidth = Math.max(2.5, Math.round(minDim * 0.003));
  ctx.strokeRect(x1, y1, w1, h1);

  ctx.shadowColor = '#FF007F';
  ctx.shadowBlur = Math.round(minDim * 0.018);
  ctx.strokeStyle = '#FF007F';
  ctx.lineWidth = Math.max(3, Math.round(minDim * 0.0035));
  ctx.strokeRect(x2, y2, w2, h2);

  var bracketL = Math.round(minDim * 0.08);
  ctx.shadowBlur = Math.round(minDim * 0.025);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(3.5, Math.round(minDim * 0.004));
  [
    [x1 - 4, y1 - 4, 1, 1],
    [x1 + w1 + 4, y1 - 4, -1, 1],
    [x1 - 4, y1 + h1 + 4, 1, -1],
    [x1 + w1 + 4, y1 + h1 + 4, -1, -1]
  ].forEach(function (b) {
    var bx = b[0], by = b[1], dx = b[2], dy = b[3];
    ctx.beginPath();
    ctx.moveTo(bx + dx * bracketL, by);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx, by + dy * bracketL);
    ctx.stroke();
  });

  var t1 = (opt.text1 != null && String(opt.text1).trim() !== '') ? String(opt.text1).trim() : '';
  var t2 = (opt.text2 != null && String(opt.text2).trim() !== '') ? String(opt.text2).trim() : '';
  if (t1) {
    ctx.save();
    var titleSize = Math.max(22, Math.round(minDim * 0.055));
    ctx.font = '900 ' + titleSize + 'px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#00F0FF';
    ctx.shadowBlur = Math.round(titleSize * 0.4);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(t1.toUpperCase(), W / 2, H - margin - Math.round(gap * 2.2));
    if (t2) {
      ctx.font = '700 ' + Math.round(titleSize * 0.55) + 'px Impact, "Arial Black", sans-serif';
      ctx.shadowColor = '#FF007F';
      ctx.fillStyle = '#00F0FF';
      ctx.fillText(t2, W / 2, H - margin - Math.round(gap * 0.8));
    }
    ctx.restore();
  }
  ctx.restore();
}

const mock2 = createMockCtx();
drawArtDecoGalaFrame(mock2, 1080, 1920, { text1: 'VIP GALA NIGHT', text2: 'DECEMBER 2026' });
console.log('Executed drawArtDecoGalaFrame successfully! Total calls:', mock2.calls.length);

const mock3 = createMockCtx();
drawNeonCyberpunkFrame(mock3, 1080, 1920, { text1: 'CYBER NIGHTS', text2: 'TOKYO 2026' });
console.log('Executed drawNeonCyberpunkFrame successfully! Total calls:', mock3.calls.length);
