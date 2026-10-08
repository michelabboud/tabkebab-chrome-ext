// core/stash-db.js — IndexedDB storage for stashed tabs

import { restoreTabWindows } from './tab-restore.js';
import { validateStashSection } from './export-schema.js';

const DB_NAME = 'TabKebabStash';
const DB_VERSION = 1;
const STORE_NAME = 'stashes';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by-createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

/**
 * Settle a readwrite transaction: resolve only on commit, reject on error or
 * abort. An aborted transaction (quota exceeded, explicit abort, connection
 * closing) fires `onabort` without necessarily firing `onerror`; without this
 * the promise would never settle and would wedge the state mutation lock.
 */
function settleWriteTransaction(tx, resolve, reject) {
  let settled = false;
  const fail = (fallback) => {
    if (settled) return;
    settled = true;
    reject(tx.error || new Error(fallback));
  };
  tx.oncomplete = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  tx.onerror = () => fail('IndexedDB stash transaction failed');
  tx.onabort = () => fail('IndexedDB stash transaction aborted');
}

export async function saveStash(stash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(stash);
    settleWriteTransaction(tx, resolve, reject);
  });
}

export async function listStashes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('by-createdAt');
    const results = [];
    const request = index.openCursor(null, 'prev');

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getStash(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteStash(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    settleWriteTransaction(tx, resolve, reject);
  });
}

export async function getAllStashes() {
  return listStashes();
}

export async function importStashes(stashes) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  // Attach settlement handlers before issuing requests so a commit or abort
  // that happens while the loop is still awaiting can never be missed.
  const settled = new Promise((resolve, reject) => {
    settleWriteTransaction(tx, resolve, reject);
  });
  settled.catch(() => {}); // observed below; avoid an unhandled-rejection report
  const store = tx.objectStore(STORE_NAME);

  let imported = 0;
  let skipped = 0;

  for (const stash of stashes) {
    const existing = await new Promise((resolve) => {
      const req = store.get(stash.id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (existing) {
      skipped++;
    } else {
      store.put(stash);
      imported++;
    }
  }

  await settled;

  return { imported, skipped };
}

export async function replaceAllStashes(stashes) {
  const validated = validateStashSection(stashes);
  const db = await openDB();

  return new Promise((resolve, reject) => {
    let transaction;
    let firstError = null;
    try {
      transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const requests = [store.clear(), ...validated.map((stash) => store.put(stash))];
      for (const request of requests) {
        request.onerror = () => {
          firstError ||= request.error || new Error('IndexedDB stash replacement request failed');
        };
      }
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // The original synchronous IndexedDB failure remains authoritative.
      }
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      firstError ||= transaction.error || new Error('IndexedDB stash replacement failed');
    };
    transaction.onabort = () => {
      reject(firstError || transaction.error || new Error('IndexedDB stash replacement aborted'));
    };
  });
}

export async function clearAllStashes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    settleWriteTransaction(tx, resolve, reject);
  });
}

// ── Restore ──

/**
 * Restore a stash through the shared tab-restore coordinator.
 */
export async function restoreStashTabs(stash, options = {}) {
  return restoreTabWindows(stash?.windows || [], options);
}
