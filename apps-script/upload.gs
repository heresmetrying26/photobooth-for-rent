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
// The first deploy after adding email asks for the "Send email as you" permission: allow it.
// Emails ("Forgot your code?") are sent from this Google account (about 100 a day on a free account).

var ROOT_FOLDER_ID = '1gwMiPTDJzqYKevAZmscPvCzpM5937a8y';
var MAX_IMAGE_BASE64 = 40 * 1024 * 1024; // larger GIF sessions; gallery relay caps downloads at 30 MB

// ---------- ticket check ----------
// Any signed ticket (upload or mail), or null.
function verifySigned_(ticket) {
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
  if (!t || !t.exp || t.exp < Date.now()) return null;
  return t;
}
// Upload ticket: must name a folder.
function verifyTicket_(ticket) {
  var t = verifySigned_(ticket);
  return t && t.f && !t.m ? t : null;
}
// Mail ticket ("Forgot your code?", Admin "Email code"): signed by the server,
// valid 2 minutes, and each ticket sends only once.
function verifyMailTicket_(ticket) {
  var t = verifySigned_(ticket);
  if (!t || t.m !== 'mail' || !t.to || t.f) return null;
  var cache = CacheService.getScriptCache(), key = 'mail_' + String(ticket).split('.')[1].slice(0, 60);
  if (cache.get(key)) return null;
  cache.put(key, '1', 600);
  return t;
}
// Trash ticket (Admin "Delete event photos", when a client or guest asks for photos to be removed early):
// signed by the server, valid 2 minutes, and each ticket works once. It names ONE folder id.
function verifyTrashTicket_(ticket) {
  var t = verifySigned_(ticket);
  if (!t || t.m !== 'trash' || t.f || !/^[A-Za-z0-9_-]{10,80}$/.test(String(t.id || ''))) return null;
  var cache = CacheService.getScriptCache(), key = 'trash_' + String(ticket).split('.')[1].slice(0, 60);
  if (cache.get(key)) return null;
  cache.put(key, '1', 600);
  return t;
}
// Moves one event folder (and what is inside it) to the Drive Trash, the same way the cleanup script does.
// Only folders inside ROOT_FOLDER_ID can be trashed, never the root itself.
function trashEventFolder_(id) {
  if (id === ROOT_FOLDER_ID) return { ok: false, error: 'not-allowed' };
  var folder;
  try { folder = DriveApp.getFolderById(id); } catch (err) { return { ok: false, error: 'not-found' }; }
  if (!isInsideRoot_(folder)) return { ok: false, error: 'not-allowed' };
  if (folder.isTrashed()) return { ok: true, already: true };
  folder.setTrashed(true);
  return { ok: true };
}
function sendMail_(t) {
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'Daily email limit reached. Try again tomorrow.' };
  MailApp.sendEmail({ to: String(t.to), subject: String(t.s || 'photobooth4u'), body: String(t.b || ''), htmlBody: t.h ? String(t.h) : undefined, name: 'photobooth4u' });
  return { ok: true };
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
    if (data.mail) {
      var mt = verifyMailTicket_(data.mail);
      if (!mt) return jsonOut({ ok: false, error: 'Email not allowed (missing, used or expired ticket).' });
      return jsonOut(sendMail_(mt));
    }
    if (data.trash) {
      var tt = verifyTrashTicket_(data.trash);
      if (!tt) return jsonOut({ ok: false, error: 'Delete not allowed (missing, used or expired ticket).' });
      return jsonOut(trashEventFolder_(String(tt.id)));
    }
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

    // Photos, GIFs and (360 / guestbook) videos. Videos are shared by their Drive preview, not relayed.
    var mime = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm|x-m4v))$/.test(data.mimeType || '') ? data.mimeType : 'image/png';
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

// ---------- online gallery (read-only) ----------
// GET ?action=list&folder=<id> lists the photos in ONE event folder,
// for the photobooth4u gallery page (/g/<id>). Only folders inside
// ROOT_FOLDER_ID can be listed, and they are already "anyone with the link".
var GALLERY_EVENT_DAYS = 7;          // keep in sync with EVENT_DAYS in cleanup.gs
var GALLERY_SHORT_DAYS = 1;          // Bonus folders (BONUS_DAYS in cleanup.gs)
var GALLERY_TRIAL_DAYS = 1 / 24;     // trial folders: 1 hour after the last photo (TRIAL_DAYS in cleanup.gs)
var GALLERY_TRIAL_RE = /^Trial test shots [A-Z0-9]{6}$/;   // TRIAL_PREFIX in cleanup.gs

function isInsideRoot_(folder) {
  var cur = folder;
  for (var depth = 0; depth < 6; depth++) {
    var parents = cur.getParents();
    if (!parents.hasNext()) return false;
    cur = parents.next();
    if (cur.getId() === ROOT_FOLDER_ID) return true;
  }
  return false;
}

function appendGalleryPhotos_(folder, files, depth) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed() || !/^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm|x-m4v))$/.test(f.getMimeType())) continue;
    files.push({ id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(), t: f.getDateCreated().getTime() });
  }
  if (depth >= 4) return;
  var folders = folder.getFolders();
  while (folders.hasNext()) {
    var child = folders.next();
    if (!child.isTrashed()) appendGalleryPhotos_(child, files, depth + 1);
  }
}

function listGallery_(id) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || id === ROOT_FOLDER_ID) return { ok: false, error: 'not-found' };
  var folder;
  try { folder = DriveApp.getFolderById(id); } catch (err) { return { ok: false, error: 'not-found' }; }
  if (folder.isTrashed() || !isInsideRoot_(folder)) return { ok: false, error: 'not-found' };

  // Include photos in event subfolders (such as Bonus), not just the root.
  var files = [];
  appendGalleryPhotos_(folder, files, 0);
  files.sort(function (a, b) { return b.t - a.t; });
  var newest = files.length ? files[0].t : 0;

  var name = folder.getName(), title = name, until = null, day = 24 * 60 * 60 * 1000;
  if (name === 'Bonus') {
    var p = folder.getParents();
    title = (p.hasNext() ? p.next().getName() + ' · ' : '') + 'Bonus';
    until = folder.getDateCreated().getTime() + GALLERY_SHORT_DAYS * day;
  } else if (GALLERY_TRIAL_RE.test(name)) {
    until = (newest || folder.getDateCreated().getTime()) + GALLERY_TRIAL_DAYS * day;   // from the last trial photo
  } else if (newest) {
    until = newest + GALLERY_EVENT_DAYS * day;
  }
  return { ok: true, name: title, folderUrl: folder.getUrl(), until: until, files: files };
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'list') return jsonOut(listGallery_(p.folder));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Photo booth relay is live.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
