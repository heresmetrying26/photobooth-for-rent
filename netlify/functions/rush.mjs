import rush from '../lib/rush.mjs';
import { safe, json, checkLicense } from '../lib/core.mjs';

// The Rush ID & Photo Print screens (source: rush-id/). /rush/ opens the booth page in "station mode"
// (see "Rush station" in protected/booth.html): the booth keeps the cameras and printers, and these screens sit on top
// of it inside a frame. Like the booth itself, the screens are never a public file: they are sent only to a valid code
// that Admin has switched "Rush ID station" on for. The booth's own licence check (every 5 minutes) covers expiry.
export default safe(async (req) => {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const device = req.headers.get('x-device-id') || '';
  const res = await checkLicense(token, device);
  if (!res.valid) return json({ error: 'locked', reason: res.reason }, 401);
  if (!res.rushOpt) return json({ error: 'locked', reason: 'no-rush' }, 403);

  // Read by the screens at start-up, so it goes in <head>. They share the booth page's sign-in (same origin).
  const cfg = '<script>window.__RUSH={embedded:true,api:"/api/rush/session",uploadPath:"/rush/u/",vendor:"/rush/vendor/",' +
    'headers:function(){return {"Authorization":"Bearer "+localStorage.getItem("pb_token"),"X-Device-Id":localStorage.getItem("pb_device")||""};}};</script>';
  let html = rush;
  const h = html.indexOf('</head>');
  html = h >= 0 ? html.slice(0, h) + cfg + html.slice(h) : cfg + html;

  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-refreshed-token': res.token } });
});

export const config = { path: '/api/rush' };
