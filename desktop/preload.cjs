// Bridge between the booth page and the app (no Node access for the page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pb4u', {
  desktop: true,
  // This laptop's address for guests' phones (http://<ip>:<port>) or null when it isn't on a network.
  lanBase: () => ipcRenderer.sendSync('pb4u:lan'),
  info: () => ipcRenderer.invoke('pb4u:info'),
  activate: (code) => ipcRenderer.invoke('pb4u:activate', String(code || '')),
  activateOffline: (text) => ipcRenderer.invoke('pb4u:activateOffline', String(text || '')),
  checkin: () => ipcRenderer.invoke('pb4u:checkin'),
  deactivate: () => ipcRenderer.invoke('pb4u:deactivate'),
  openPhotos: (folderUrl) => ipcRenderer.invoke('pb4u:openPhotos', folderUrl ? String(folderUrl) : ''),
  choosePhotos: () => ipcRenderer.invoke('pb4u:choosePhotos'),
  // 360 videos
  spinInfo: () => ipcRenderer.invoke('pb4u:spinInfo'),
  spinChoose: () => ipcRenderer.invoke('pb4u:spinChoose'),
  spinScan: () => ipcRenderer.invoke('pb4u:spinScan'),
  spinEnv: () => ipcRenderer.invoke('pb4u:spinEnv'),
  spinMusic: (clear) => ipcRenderer.invoke('pb4u:spinMusic', !!clear),
  spinOverlay: (bytes) => ipcRenderer.invoke('pb4u:spinOverlay', bytes),
  spinProcess: (req) => ipcRenderer.invoke('pb4u:spinProcess', req),
  spinJob: (id) => ipcRenderer.invoke('pb4u:spinJob', id),
  spinCancel: (id) => ipcRenderer.invoke('pb4u:spinCancel', id),
  spinShare: (name, folderKey, subfolder, outName) => ipcRenderer.invoke('pb4u:spinShare', String(name || ''), String(folderKey || ''), String(subfolder || ''), String(outName || '')),
  // Roving photos sent from a phone
  roveInfo: () => ipcRenderer.invoke('pb4u:roveInfo'),
  roveScan: () => ipcRenderer.invoke('pb4u:roveScan'),
  roveTake: (name) => ipcRenderer.invoke('pb4u:roveTake', String(name || '')),
  // Guests asking for a print
  guestPrintSet: (on) => ipcRenderer.invoke('pb4u:guestPrintSet', !!on),
  printReqList: () => ipcRenderer.invoke('pb4u:printReqList'),
  printReqDone: (id) => ipcRenderer.invoke('pb4u:printReqDone', String(id || '')),
  printReqRead: (id) => ipcRenderer.invoke('pb4u:printReqRead', String(id || '')),
  // Photographer desk folder watching
  deskFolder: () => ipcRenderer.invoke('pb4u:deskFolder'),
  deskChoose: () => ipcRenderer.invoke('pb4u:deskChoose'),
  deskScan: () => ipcRenderer.invoke('pb4u:deskScan'),
  deskRead: (name) => ipcRenderer.invoke('pb4u:deskRead', String(name || '')),
  copy: (t) => ipcRenderer.invoke('pb4u:copy', String(t || '')),
  openUrl: (u) => ipcRenderer.invoke('pb4u:openUrl', String(u || '')),
  quit: () => ipcRenderer.invoke('pb4u:quit'),
  freeCamera: () => ipcRenderer.invoke('pb4u:freeCamera'),
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
