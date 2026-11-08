// Past orders: the finished sheets of every print / save, kept on THIS device only (IndexedDB), so staff can find, reprint or delete them.
// Customers never see it: it is behind the staff PIN. Staff set how many days to keep them (0 = keep nothing).
const DB_NAME = 'rushid-orders', V = 1;
let dbP = null;
function open() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, V);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('orders', { keyPath: 'id' }); d.createObjectStore('sheets', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => { dbP = null; rej(r.error); };
  });
  return dbP;
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const get = (store, key) => new Promise((res, rej) => { const q = store.get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const all = (store) => new Promise((res, rej) => { const q = store.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });

// order: { kind, lines, paper:{id,label,w,h}, sets, thumb:Blob }, sheets: [Blob]
export async function saveOrder(order, sheets) {
  const d = await open(), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tx = d.transaction(['orders', 'sheets'], 'readwrite');
  tx.objectStore('orders').put({ ...order, id, t: Date.now(), n: sheets.length });
  tx.objectStore('sheets').put({ id, blobs: sheets });
  await done(tx); return id;
}
export async function listOrders() {
  const d = await open(); const rows = await all(d.transaction('orders').objectStore('orders'));
  return rows.sort((a, b) => b.t - a.t);
}
export async function getSheets(id) {
  const d = await open(); const r = await get(d.transaction('sheets').objectStore('sheets'), id);
  return r ? r.blobs : [];
}
export async function deleteOrder(id) {
  const d = await open(), tx = d.transaction(['orders', 'sheets'], 'readwrite');
  tx.objectStore('orders').delete(id); tx.objectStore('sheets').delete(id); await done(tx);
}
export async function clearOrders() {
  const d = await open(), tx = d.transaction(['orders', 'sheets'], 'readwrite');
  tx.objectStore('orders').clear(); tx.objectStore('sheets').clear(); await done(tx);
}
// Delete orders older than `days` (0 = delete everything) and keep at most `max`.
export async function prune(days, max = 300) {
  const rows = await listOrders(), cut = days > 0 ? Date.now() - days * 86400000 : Infinity;
  let n = 0;
  for (let i = 0; i < rows.length; i++) if (days <= 0 || rows[i].t < cut || i >= max) { await deleteOrder(rows[i].id); n++; }
  return n;
}
