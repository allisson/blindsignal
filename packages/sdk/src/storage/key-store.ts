// IndexedDB has no Node.js implementation: the Playwright tests cover this file, as they do
// src/webrtc/.
const DATABASE = 'blindsignal';
const STORE = 'keys';
const KEY = 'device';

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * This origin's device key pair, created on first use. The pair is generated before the
 * transaction, which an await on anything but IndexedDB would end; inside it, the stored pair
 * wins, so tabs loading at once all keep the first pair written.
 */
export async function loadKeyPair(): Promise<CryptoKeyPair> {
  const generated = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  const database = await settled(opening);
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    let pair = generated;
    const stored = store.get(KEY);
    stored.onsuccess = () => {
      if (stored.result) pair = stored.result as CryptoKeyPair;
      else store.put(generated, KEY);
    };
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
    });
    return pair;
  } finally {
    database.close();
  }
}
