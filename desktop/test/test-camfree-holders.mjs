// Names the app that is using the camera (Windows keeps a start / stop time per app; stop = 0 means in use now).
// Run from desktop/:  node test/test-camfree-holders.mjs
import { strict as assert } from 'node:assert';
import { cameraHolders } from '../lib/camfree.mjs';

const ROOT = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';
const REG = [
  ROOT,
  '    Value    REG_SZ    Allow',
  '',
  ROOT + '\\Microsoft.WindowsCamera_8wekyb3d8bbwe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  ROOT + '\\NonPackaged',
  '    Value    REG_SZ    Allow',
  '',
  ROOT + '\\NonPackaged\\C:#Program Files#obs-studio#bin#64bit#obs64.exe',
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  ROOT + '\\NonPackaged\\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe',
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x1dc5a1b2d0000000',
  '',
  ROOT + '\\NonPackaged\\C:#Program Files#Old#crashed.exe',
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  ROOT + '\\NonPackaged\\C:#Program Files#photobooth4u#photobooth4u.exe',
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dc5a1b2c3d4e5f6',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  ROOT + '\\NonPackaged\\C:#Tools#never.exe',
  '    LastUsedTimeStart    REG_QWORD    0x0',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  ''
].join('\r\n');

const alive = new Set(['obs64.exe', 'photobooth4u.exe']);   // crashed.exe is not running any more
const h = await cameraHolders({ platform: 'win32', regOut: REG, running: async (exe) => alive.has(exe), selfPath: 'C:\\Program Files\\photobooth4u\\photobooth4u.exe' });
const names = h.map((x) => x.name);
assert.deepEqual(names, ['WindowsCamera', 'obs64'], 'in use now: Windows Camera and OBS only, got ' + JSON.stringify(names));
console.log('PASS: only apps that are using the camera now are named (finished, never-used, crashed and this booth are left out)');

assert.deepEqual(await cameraHolders({ platform: 'darwin' }), [], 'not Windows: nothing');
assert.deepEqual(await cameraHolders({ platform: 'win32', regOut: '' }), [], 'empty registry output: nothing');
console.log('PASS: other systems and empty output give an empty list');
