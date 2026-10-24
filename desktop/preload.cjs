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
  copy: (t) => ipcRenderer.invoke('pb4u:copy', String(t || '')),
  openUrl: (u) => ipcRenderer.invoke('pb4u:openUrl', String(u || '')),
  quit: () => ipcRenderer.invoke('pb4u:quit'),
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
