// photobooth4u – Drive upload relay (Apps Script web app).
//
// SECURITY: every request must carry a "ticket" signed by the photobooth4u
// server (Netlify) with UPLOAD_SECRET. The ticket says which ONE folder (and
// optional subfolder) the booth may use, and when it expires. The folder name
// or link sent by the browser is ignored — only the ticket counts.
//
// Setup: Project Settings (gear icon) → Script Properties → add
//   UPLOAD_SECRET = <the exact same value as UPLOAD_SECRET in Netlify>
// then Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.

var ROOT_FOLDER_ID = '1gwMiPTDJzqYKevAZmscPvCzpM5937a8y';
var MAX_IMAGE_BASE64 = 20 * 1024 * 1024; // ~15 MB image

// ---------- ticket check ----------
function verifyTicket_(ticket) {
  var secret = PropertiesService.getScriptProperties().getProperty('UPLOAD_SECRET');
  if (!secret) throw new Error('UPLOAD_SECRET is not set in Script Properties.');
  var parts = String(ticket || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  var expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], secret, Utilities.Charset.UTF_8)
  ).replace(/=+$/, '');
  if (!safeEqual_(expected, parts[1])) return null;
  var body = parts[0];
  while (body.length % 4) body += '=';
  var t = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString('UTF-8'));
  if (!t || !t.f || !t.exp || t.exp < Date.now()) return null;
  return t;
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- folders ----------
function extractFolderId(raw) {
  var trimmed = (raw || '').trim();
  if (!trimmed) return null;
  var folderUrlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderUrlMatch) return folderUrlMatch[1];
  var idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

// First folder with this name that is NOT in the Trash (the cleanup script
// trashes old event folders; a new booking with the same name must not reuse one).
function findChild_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

// folderKey comes from the signed ticket, i.e. from the server (Admin's
// "Drive folder name", "<client> · <event>", or a trial folder). A Drive link
// is only possible if YOU typed one into Admin.
function resolveFolder(folderKey) {
  var trimmed = (folderKey || '').trim();
  var maybeId = extractFolderId(trimmed);
  if (maybeId) {
    try {
      var byId = DriveApp.getFolderById(maybeId);
      if (!byId.isTrashed()) return byId;
    } catch (err) {
      // Not accessible — treat the text as a name instead.
    }
  }
  var root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  return findChild_(root, trimmed) || root.createFolder(trimmed);
}

function resolveTicketFolder_(t) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // two devices at once must not create two folders with one name
  try {
    var folder = resolveFolder(t.f);
    if (t.s) {
      var sub = String(t.s).trim();
      folder = findChild_(folder, sub) || folder.createFolder(sub);
    }
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return folder;
  } finally {
    lock.releaseLock();
  }
}

// Next free session number from the files already in the folder
// ("3_strip.png", "3_strip_cam2.png" -> 4).
function getNextSessionNumber(folder) {
  var files = folder.getFiles();
  var maxNum = 0;
  var re = /^(\d+)_/;
  while (files.hasNext()) {
    var f = files.next();
    if (f.isTrashed()) continue;
    var m = f.getName().match(re);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return maxNum + 1;
}

// ---------- web app ----------
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var t = verifyTicket_(data.ticket);
    if (!t) return jsonOut({ ok: false, error: 'Upload not allowed (missing or expired ticket). Reload the booth and try again.' });

    var folder = resolveTicketFolder_(t);

    if (data.resolveOnly) {
      return jsonOut({ ok: true, folderName: folder.getName(), folderUrl: folder.getUrl(), nextSessionNumber: getNextSessionNumber(folder) });
    }
    if (data.getNextNumber) {
      return jsonOut({ ok: true, nextSessionNumber: getNextSessionNumber(folder) });
    }

    var b64 = String(data.imageBase64 || '');
    if (!b64) return jsonOut({ ok: false, error: 'No image data was received.' });
    if (b64.length > MAX_IMAGE_BASE64) return jsonOut({ ok: false, error: 'Image is too large.' });

    var mime = /^image\/(png|jpeg|gif|webp)$/.test(data.mimeType || '') ? data.mimeType : 'image/png';
    var name = String(data.filename || ('photo-' + Date.now() + '.png')).replace(/[\/\\]/g, '_').slice(0, 120);
    var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return jsonOut({
      ok: true,
      fileId: file.getId(),
      fileName: file.getName(),
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      downloadUrl: 'https://drive.google.com/uc?export=download&id=' + file.getId()
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Photo booth relay is live.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
