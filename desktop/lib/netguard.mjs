// Which web addresses the booth page may load. Nothing leaves the laptop from the booth page except:
//   - the fonts, the print helper on this laptop (port 17321),
//   - this laptop's own share server (the 360 videos, phone photos), on 127.0.0.1 and only on the port it listens on.
export function allowBoothRequest(url, sharePort) {
  const u = String(url || '');
  if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost):17321\//.test(u)) return true;
  const p = Number(sharePort);
  if (p > 0 && (u.startsWith('http://127.0.0.1:' + p + '/') || u.startsWith('http://localhost:' + p + '/'))) return true;
  return false;
}
