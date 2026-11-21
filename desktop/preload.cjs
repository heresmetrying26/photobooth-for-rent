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
  // Option 1: notify the app that a photo session has begun (wakes hotspot from idle if needed).
  hotspotWake: () => ipcRenderer.invoke('pb4u:hotspotWake'),
  // The app calls fn(info) whenever the hotspot changes (on, off, locked), so the page doesn't have to poll.
  onHotspot: (fn) => { ipcRenderer.on('pb4u:hotspotChanged', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); },
  // Saves the operator's own booth Wi-Fi name and password (Windows): { ok, error, info }
  hotspotCreds: (ssid, pass) => ipcRenderer.invoke('pb4u:hotspotCreds', String(ssid || ''), String(pass || '')),
  hotspotSetup: () => ipcRenderer.invoke('pb4u:hotspotSetup'),
  info: () => ipcRenderer.invoke('pb4u:info'),
  activate: (code) => ipcRenderer.invoke('pb4u:activate', String(code || '')),
  activateOffline: (text) => ipcRenderer.invoke('pb4u:activateOffline', String(text || '')),
  checkin: () => ipcRenderer.invoke('pb4u:checkin'),
  syncNow: () => ipcRenderer.invoke('pb4u:syncNow'),
  onSetupSynced: (fn) => { ipcRenderer.on('pb4u:setupSynced', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); },
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
  spinMusicAdd: () => ipcRenderer.invoke('pb4u:spinMusicAdd'),
  spinConnect: (test) => ipcRenderer.invoke('pb4u:spinConnect', !!test),
  spinExtra: (req) => ipcRenderer.invoke('pb4u:spinExtra', { name: String((req && req.name) || ''), kind: (req && req.kind) === 'square' ? 'square' : 'gif' }),
  spinStingerAdd: () => ipcRenderer.invoke('pb4u:spinStingerAdd'),
  spinStingerRemove: (name) => ipcRenderer.invoke('pb4u:spinStingerRemove', String(name || '')),
  spinLookOffer: (offer) => ipcRenderer.invoke('pb4u:spinLookOffer', offer || {}),
  spinPicks: () => ipcRenderer.invoke('pb4u:spinPicks'),
  spinSendSet: (cfg) => ipcRenderer.invoke('pb4u:spinSendSet', cfg || {}),
  spinClipsSet: (list) => ipcRenderer.invoke('pb4u:spinClipsSet', Array.isArray(list) ? list : []),
  spinSendTake: () => ipcRenderer.invoke('pb4u:spinSendTake'),
  spinStats: (folderKey, subfolder) => ipcRenderer.invoke('pb4u:spinStats', String(folderKey || ''), String(subfolder || '')),
  spinMusicRemove: (name) => ipcRenderer.invoke('pb4u:spinMusicRemove', String(name || '')),
  spinIntro: (clear) => ipcRenderer.invoke('pb4u:spinIntro', !!clear),
  spinOutro: (clear) => ipcRenderer.invoke('pb4u:spinOutro', !!clear),
  spinOverlay: (bytes) => ipcRenderer.invoke('pb4u:spinOverlay', bytes),
  spinFxBake: (bytes) => ipcRenderer.invoke('pb4u:spinFxBake', bytes),
  spinProxy: (name) => ipcRenderer.invoke('pb4u:spinProxy', name),
  spinProcess: (req) => ipcRenderer.invoke('pb4u:spinProcess', req),
  spinJob: (id) => ipcRenderer.invoke('pb4u:spinJob', id),
  spinCancel: (id) => ipcRenderer.invoke('pb4u:spinCancel', id),
  spinExtractFrames: (req) => ipcRenderer.invoke('pb4u:spinExtractFrames', req),
  spinDelete: (name) => ipcRenderer.invoke('pb4u:spinDelete', name),
  setWallCue: (action, text, durationMs) => ipcRenderer.invoke('pb4u:setWallCue', action, text, durationMs),
  spinShare: (name, folderKey, subfolder, outName, look) => ipcRenderer.invoke('pb4u:spinShare', String(name || ''), String(folderKey || ''), String(subfolder || ''), String(outName || ''), String(look || '')),
  spinStationUrl: (slug) => ipcRenderer.invoke('pb4u:spinStationUrl', slug ? String(slug) : ''),
  spinWallUrl: (slug) => ipcRenderer.invoke('pb4u:spinWallUrl', slug ? String(slug) : ''),
  spinStats: (slug) => ipcRenderer.invoke('pb4u:spinStats', slug ? String(slug) : ''),
  // Roving photos sent from a phone
  roveInfo: () => ipcRenderer.invoke('pb4u:roveInfo'),
  roveScan: () => ipcRenderer.invoke('pb4u:roveScan'),
  roveTake: (name) => ipcRenderer.invoke('pb4u:roveTake', String(name || '')),
  roveStateSet: (st) => ipcRenderer.invoke('pb4u:roveStateSet', st || {}),
  roveCmdTake: () => ipcRenderer.invoke('pb4u:roveCmdTake'),
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
  studioFolders: (key, sub) => ipcRenderer.invoke('pb4u:studioFolders', String(key || ''), String(sub || '')),
  studioList: (slug) => ipcRenderer.invoke('pb4u:studioList', String(slug || '')),
  studioRead: (slug, name) => ipcRenderer.invoke('pb4u:studioRead', String(slug || ''), String(name || '')),
  // Photographer desk folder watching & standalone window
  deskFolder: () => ipcRenderer.invoke('pb4u:deskFolder'),
  deskChoose: () => ipcRenderer.invoke('pb4u:deskChoose'),
  deskScan: () => ipcRenderer.invoke('pb4u:deskScan'),
  deskRead: (name) => ipcRenderer.invoke('pb4u:deskRead', String(name || '')),
  openPhotomanWindow: () => ipcRenderer.invoke('pb4u:openPhotomanWindow'),
  focusBoothWindow: () => ipcRenderer.invoke('pb4u:focusBoothWindow'),
  onPhotomanState: (fn) => { ipcRenderer.on('pb4u:photomanState', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); },
  ipadInfo: () => ipcRenderer.invoke('pb4u:ipadInfo'),
  ipadSet: (on, renewPin) => ipcRenderer.invoke('pb4u:ipadSet', !!on, !!renewPin),
  copy: (t) => ipcRenderer.invoke('pb4u:copy', String(t || '')),
  openUrl: (u) => ipcRenderer.invoke('pb4u:openUrl', String(u || '')),
  quit: () => ipcRenderer.invoke('pb4u:quit'),
  freeCamera: () => ipcRenderer.invoke('pb4u:freeCamera'),
  usbScan: () => ipcRenderer.invoke('pb4u:usbScan'),
  // Reconnects an Instax printer set up before (Bluetooth), by its name: { ok, name } / { ok:false, error }
  bluetoothReconnect: (name) => ipcRenderer.invoke('pb4u:bluetoothReconnect', String(name || '')),
  bridge: {
    info: () => ipcRenderer.invoke('pb4u:bridgeInfo'),
    renew: () => ipcRenderer.invoke('pb4u:bridgeRenew'),
    pushState: (state) => ipcRenderer.invoke('pb4u:bridgeState', state || {}),
    sendEvent: (ev) => ipcRenderer.invoke('pb4u:bridgeEvent', ev || {}),
    camCmd: (cmd) => ipcRenderer.invoke('pb4u:bridgeCamCmd', cmd || {}),
    onStatus: (fn) => { ipcRenderer.on('pb4u:bridgeStatus', (e, info) => { try { fn(info); } catch (err) { /* ignore */ } }); },
    onAction: (fn) => { ipcRenderer.on('pb4u:bridgeAction', (e, act) => { try { fn(act); } catch (err) { /* ignore */ } }); }
  },
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
