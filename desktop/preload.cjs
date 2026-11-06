// Bridge between the booth page and the app (no Node access for the page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pb4u', {
  desktop: true,
  // This laptop's address for guests' phones (http://<ip>:<port>) or null when it isn't on a network.
  lanBase: () => ipcRenderer.sendSync('pb4u:lan'),
  // The Wi-Fi this laptop is on: { ssid, pass, open, passKnown } (ssid is '' when it isn't on Wi-Fi).
  wifi: (force) => ipcRenderer.invoke('pb4u:wifi', !!force),
  // The booth's own Wi-Fi (Windows): { supported, on, wanted, busy, ssid, pass, auto, error, needsSetup }
  hotspot: () => ipcRenderer.invoke('pb4u:hotspot'),
  hotspotSet: (on) => ipcRenderer.invoke('pb4u:hotspotSet', !!on),
  hotspotAuto: (on) => ipcRenderer.invoke('pb4u:hotspotAuto', !!on),
  // Saves the operator's own booth Wi-Fi name and password (Windows): { ok, error, info }
  hotspotCreds: (ssid, pass) => ipcRenderer.invoke('pb4u:hotspotCreds', String(ssid || ''), String(pass || '')),
  hotspotSetup: () => ipcRenderer.invoke('pb4u:hotspotSetup'),
  info: () => ipcRenderer.invoke('pb4u:info'),
  activate: (code) => ipcRenderer.invoke('pb4u:activate', String(code || '')),
  activateOffline: (text) => ipcRenderer.invoke('pb4u:activateOffline', String(text || '')),
  checkin: () => ipcRenderer.invoke('pb4u:checkin'),
  deactivate: () => ipcRenderer.invoke('pb4u:deactivate'),
  openPhotos: (folderUrl) => ipcRenderer.invoke('pb4u:openPhotos', folderUrl ? String(folderUrl) : ''),
  choosePhotos: () => ipcRenderer.invoke('pb4u:choosePhotos'),
  // Save a file the booth made (e.g. the Wi-Fi sign) with a Save As box: null when cancelled, else { ok, path, dir } / { ok:false, error }
  saveFile: (name, bytes) => ipcRenderer.invoke('pb4u:saveFile', String(name || ''), bytes),  // 360 videos
  spinInfo: () => ipcRenderer.invoke('pb4u:spinInfo'),
  spinChoose: () => ipcRenderer.invoke('pb4u:spinChoose'),
  spinScan: () => ipcRenderer.invoke('pb4u:spinScan'),
  spinEnv: () => ipcRenderer.invoke('pb4u:spinEnv'),
  spinFxList: () => ipcRenderer.invoke('pb4u:spinFxList'),
  spinMusic: (clear) => ipcRenderer.invoke('pb4u:spinMusic', !!clear),
  spinIntro: (clear) => ipcRenderer.invoke('pb4u:spinIntro', !!clear),
  spinOutro: (clear) => ipcRenderer.invoke('pb4u:spinOutro', !!clear),
  spinOverlay: (bytes) => ipcRenderer.invoke('pb4u:spinOverlay', bytes),
  spinFxBake: (bytes) => ipcRenderer.invoke('pb4u:spinFxBake', bytes),
  spinProcess: (req) => ipcRenderer.invoke('pb4u:spinProcess', req),
  spinJob: (id) => ipcRenderer.invoke('pb4u:spinJob', id),
  spinCancel: (id) => ipcRenderer.invoke('pb4u:spinCancel', id),
  spinExtractFrames: (req) => ipcRenderer.invoke('pb4u:spinExtractFrames', req),
  spinDelete: (name) => ipcRenderer.invoke('pb4u:spinDelete', name),
  setWallCue: (action, text, durationMs) => ipcRenderer.invoke('pb4u:setWallCue', action, text, durationMs),
  spinShare: (name, folderKey, subfolder, outName) => ipcRenderer.invoke('pb4u:spinShare', String(name || ''), String(folderKey || ''), String(subfolder || ''), String(outName || '')),
  spinStationUrl: (slug) => ipcRenderer.invoke('pb4u:spinStationUrl', slug ? String(slug) : ''),
  spinWallUrl: (slug) => ipcRenderer.invoke('pb4u:spinWallUrl', slug ? String(slug) : ''),
  spinStats: (slug) => ipcRenderer.invoke('pb4u:spinStats', slug ? String(slug) : ''),
  // Roving photos sent from a phone
  roveInfo: () => ipcRenderer.invoke('pb4u:roveInfo'),
  roveScan: () => ipcRenderer.invoke('pb4u:roveScan'),
  roveTake: (name) => ipcRenderer.invoke('pb4u:roveTake', String(name || '')),
  // Guests asking for a print
  news: () => ipcRenderer.invoke('pb4u:news'),
  // The operator tapped "Print photo" on an earlier photo in All photos: the booth prints it now.
  printNowTake: () => ipcRenderer.invoke('pb4u:printNowTake'),
  printNowDone: (id, ok, msg) => ipcRenderer.invoke('pb4u:printNowDone', String(id || ''), !!ok, String(msg || '')),
  guestPrintSet: (on) => ipcRenderer.invoke('pb4u:guestPrintSet', !!on),
  guestViewSet: (mode) => ipcRenderer.invoke('pb4u:guestViewSet', String(mode || '')),
  printReqList: () => ipcRenderer.invoke('pb4u:printReqList'),
  printReqDone: (id) => ipcRenderer.invoke('pb4u:printReqDone', String(id || '')),
  printReqRead: (id) => ipcRenderer.invoke('pb4u:printReqRead', String(id || '')),
  // Photographer desk folder watching
  deskFolder: () => ipcRenderer.invoke('pb4u:deskFolder'),
  deskChoose: () => ipcRenderer.invoke('pb4u:deskChoose'),
  deskScan: () => ipcRenderer.invoke('pb4u:deskScan'),
  deskRead: (name) => ipcRenderer.invoke('pb4u:deskRead', String(name || '')),
  ipadInfo: () => ipcRenderer.invoke('pb4u:ipadInfo'),
  ipadSet: (on, renewPin) => ipcRenderer.invoke('pb4u:ipadSet', !!on, !!renewPin),
  copy: (t) => ipcRenderer.invoke('pb4u:copy', String(t || '')),
  openUrl: (u) => ipcRenderer.invoke('pb4u:openUrl', String(u || '')),
  quit: () => ipcRenderer.invoke('pb4u:quit'),
  freeCamera: () => ipcRenderer.invoke('pb4u:freeCamera'),
  usbScan: () => ipcRenderer.invoke('pb4u:usbScan'),
  update: {
    info: () => ipcRenderer.invoke('pb4u:update'),
    check: () => ipcRenderer.invoke('pb4u:updateCheck'),
    download: () => ipcRenderer.invoke('pb4u:updateDownload'),
    open: () => ipcRenderer.invoke('pb4u:updateOpen'),
    install: () => ipcRenderer.invoke('pb4u:updateInstall'),
    on: (fn) => { ipcRenderer.on('pb4u:update', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); }
  },
  onLicence: (fn) => { ipcRenderer.on('pb4u:licence', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); }
});
