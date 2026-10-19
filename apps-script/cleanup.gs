// photobooth4u – Drive cleanup. Runs every 15 minutes (see createHourlyTrigger).
const PARENT_FOLDER_ID = '1gwMiPTDJzqYKevAZmscPvCzpM5937a8y';

const EVENT_DAYS = 7;    // event photos stay this long after the LAST event photo
const TRIAL_DAYS = 1 / 24; // trial folders: 1 hour after the trial's last photo
const BONUS_DAYS = 1;    // "Bonus" folders inside event folders
const EMPTY_DAYS = 60;   // event folders that never got event photos (e.g. cancelled)

const TRIAL_PREFIX = 'Trial test shots'; // must match Admin → "Trial Drive folder name"
const BONUS_NAME = 'Bonus';

const DRY_RUN = false;   // first run: only logs what it WOULD delete. Set to false after checking.

const DAY_MS = 24 * 60 * 60 * 1000;

function deleteExpiredFolders() {
  const now = Date.now();
  // Trial folders are named "<prefix> ABC123" (6-character code), so a real
  // event that merely starts with "Trial" is never caught by this.
  const trialRe = new RegExp('^' + escapeRe_(TRIAL_PREFIX) + ' [A-Z0-9]{6}$');
  const folders = DriveApp.getFolderById(PARENT_FOLDER_ID).getFolders();

  while (folders.hasNext()) {
    const folder = folders.next();
    if (folder.isTrashed()) continue;
    const name = folder.getName();

    // 1) Trial folders: counted from the trial's LAST photo (or from when the
    //    folder was made, if it has no photos).
    if (trialRe.test(name)) {
      const last = newestFileDate_(folder) || folder.getDateCreated();
      if (ageDays_(last, now) > TRIAL_DAYS) trash_(folder, 'trial');
      continue;
    }

    // 2) Bonus folder inside an event folder (the event folder itself stays)
    const subs = folder.getFoldersByName(BONUS_NAME);
    while (subs.hasNext()) {
      const bonus = subs.next();
      if (!bonus.isTrashed() && ageDays_(bonus.getDateCreated(), now) > BONUS_DAYS) {
        trash_(bonus, 'bonus in "' + name + '"');
      }
    }

    // 3) Event folder: counted from its newest event photo, not from when the
    //    folder was created (a bonus session can create it days before the event).
    const newest = newestFileDate_(folder);
    if (newest) {
      if (ageDays_(newest, now) > EVENT_DAYS) trash_(folder, 'event');
    } else if (ageDays_(folder.getDateCreated(), now) > EMPTY_DAYS) {
      trash_(folder, 'event with no photos');
    }
  }
}

// Newest photo directly in the folder (photos in the Bonus folder don't count).
function newestFileDate_(folder) {
  let newest = null;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.isTrashed()) continue;
    const d = f.getDateCreated();
    if (!newest || d > newest) newest = d;
  }
  return newest;
}

function ageDays_(date, now) { return (now - date.getTime()) / DAY_MS; }
function escapeRe_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function trash_(folder, why) {
  Logger.log((DRY_RUN ? '[dry run] would trash ' : 'Moving to Trash ') + '(' + why + '): ' + folder.getName());
  if (!DRY_RUN) folder.setTrashed(true);
}

// Run ONCE. Replaces the old trigger with one every 15 minutes, so trial
// folders go about 1 hour after the trial (not up to 2 hours).
function createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'deleteExpiredFolders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('deleteExpiredFolders').timeBased().everyMinutes(15).create();
}
