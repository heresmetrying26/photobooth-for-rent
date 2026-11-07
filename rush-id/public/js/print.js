// Printing: the sheets are 300 dpi canvases, one per paper. The browser prints them with the
// paper size forced to match, so the DNP driver gets exactly 4x6 / 5x7 / 6x8 and does not rescale.
import { canvasToBlob } from './imaging.js';

let urls = [];
const cleanup = () => {
  urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
  const a = document.getElementById('printArea'); if (a) a.innerHTML = '';
  const s = document.getElementById('pageStyle'); if (s) s.remove();
};

// canvases: portrait sheets, paper: { w, h } in inches, copies: how many of each sheet
export async function printSheets(canvases, paper, copies = 1) {
  cleanup();
  const area = document.getElementById('printArea');
  const imgs = [];
  for (const c of canvases) {
    const u = URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.96)); urls.push(u);
    for (let i = 0; i < copies; i++) { const im = new Image(); im.src = u; imgs.push(im); area.appendChild(im); }
  }
  await Promise.all(imgs.map((im) => im.decode().catch(() => {})));
  const st = document.createElement('style'); st.id = 'pageStyle';
  st.textContent = '@page{size:' + paper.w + 'in ' + paper.h + 'in;margin:0}' +
    '@media print{#printArea img{width:' + paper.w + 'in;height:' + paper.h + 'in}}';
  document.head.appendChild(st);
  await new Promise((resolve) => {
    const done = () => { window.removeEventListener('afterprint', done); setTimeout(() => { cleanup(); resolve(); }, 500); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 120000);   // safety net if the browser never reports afterprint
  });
}

export async function downloadSheets(canvases, base = 'print') {
  for (let i = 0; i < canvases.length; i++) {
    const u = URL.createObjectURL(await canvasToBlob(canvases[i], 'image/jpeg', 0.96));
    const a = document.createElement('a'); a.href = u; a.download = base + '-' + (i + 1) + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }
}
