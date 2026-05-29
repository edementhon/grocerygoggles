// Tiny IndexedDB wrapper for scan history.
// One object store, "scans", capped at MAX_HISTORY most-recent entries.

const DB_NAME = "grocery-goggles";
const DB_VERSION = 1;
const STORE = "scans";
const MAX_HISTORY = 50;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Auto-increment id is monotonic with insert order, so lowest id == oldest.
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// record: { timestamp, productGuess, thumbnails ([Blob]), ingredients ([]), nutrition }
export async function addScan(record) {
  const db = await openDB();
  const store = tx(db, "readwrite");
  const id = await done(store.add(record));
  await trim(store);
  return id;
}

// Re-save an existing scan in place (e.g. after adding a nutrition photo and
// re-analyzing), so we update the record instead of creating a duplicate.
export async function updateScan(id, record) {
  const db = await openDB();
  await done(tx(db, "readwrite").put({ ...record, id }));
  return id;
}

// Delete a scan by id (used to replace a batch when the user re-analyzes).
export async function deleteScan(id) {
  const db = await openDB();
  await done(tx(db, "readwrite").delete(id));
}

async function trim(store) {
  const count = await done(store.count());
  let toDelete = count - MAX_HISTORY;
  if (toDelete <= 0) return;
  // Walk oldest-first (ascending keys) and delete the overflow.
  await new Promise((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || toDelete <= 0) return resolve();
      cursor.delete();
      toDelete--;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// Newest first.
export async function getAllScans() {
  const db = await openDB();
  const all = await done(tx(db, "readonly").getAll());
  return all.sort((a, b) => b.id - a.id);
}

export async function clearScans() {
  const db = await openDB();
  await done(tx(db, "readwrite").clear());
}
