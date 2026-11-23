// Draws look-alike QR pictures for the guide. They are examples only and do not scan.
(function () {
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  var els = document.querySelectorAll('svg.qr');
  for (var k = 0; k < els.length; k++) {
    var el = els[k], n = 25, r = rng((Number(el.getAttribute('data-seed')) || k + 7) * 2654435761);
    var out = '<rect x="-1" y="-1" width="27" height="27" fill="#fff"/>';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if ((x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16)) continue;
      if (r() < 0.48) out += '<rect x="' + x + '" y="' + y + '" width="1.02" height="1.02"/>';
    }
    function fin(x, y) { return '<rect x="' + x + '" y="' + y + '" width="7" height="7"/><rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="5" height="5" fill="#fff"/><rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="3" height="3"/>'; }
    out += fin(0, 0) + fin(18, 0) + fin(0, 18);
    el.setAttribute('viewBox', '-1 -1 27 27');
    el.setAttribute('shape-rendering', 'crispEdges');
    el.innerHTML = out;
  }
})();
