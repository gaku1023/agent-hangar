/**
 * スマホの手元の置き場。
 *
 * Worker 用のトークンと接続先は localStorage に置く。
 * スマホ用の鍵は、取り出せない（non-extractable）CryptoKey のまま IndexedDB に置く。
 * 画面に XSS があっても、鍵の値そのものは持ち出せない（使うことはできても、写して外へ送れない）。
 * どちらの置き場も、プライベートブラウズやサイトデータの消去で投げたり空になったりするので、読み書きは全部 try/catch で包む。
 */

export type Pairing = { url: string; token: string; deviceId: string };

const PAIRING_KEY = 'hangar.mobile.pairing';
const DB_NAME = 'hangar-mobile';
const DB_STORE = 'keys';
const KEY_ID = 'mobile-key';

function isPairing(v: unknown): v is Pairing {
  const o = v as Partial<Record<keyof Pairing, unknown>> | null;
  return !!o && typeof o === 'object' && typeof o.url === 'string' && !!o.url && typeof o.token === 'string' && !!o.token && typeof o.deviceId === 'string' && !!o.deviceId;
}

export function loadPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return isPairing(v) ? { url: v.url, token: v.token, deviceId: v.deviceId } : null;
  } catch {
    return null;
  }
}

export function savePairing(p: Pairing): void {
  try {
    localStorage.setItem(PAIRING_KEY, JSON.stringify({ url: p.url, token: p.token, deviceId: p.deviceId }));
  } catch {
    // 置けなければ、次に開いたとき参加の画面に戻るだけである。
  }
}

/** 接続を忘れる。鍵も IndexedDB から消す（終わるのを待たない）。 */
export function clearPairing(): void {
  try {
    localStorage.removeItem(PAIRING_KEY);
  } catch {
    // 消せなくても、Worker がトークンを 401 で断るので受信箱は開けない。
  }
  void withStore('readwrite', (s) => s.delete(KEY_ID)).catch(() => undefined);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB がありません'));
      return;
    }
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けません'));
    req.onblocked = () => reject(new Error('IndexedDB が塞がっています'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = run(tx.objectStore(DB_STORE));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB の読み書きに失敗しました'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB の読み書きが取り消されました'));
    });
  } finally {
    db.close();
  }
}

export async function loadKey(): Promise<CryptoKey | null> {
  try {
    const v: unknown = await withStore('readonly', (s) => s.get(KEY_ID));
    return v instanceof CryptoKey ? v : null;
  } catch {
    return null;
  }
}

/** 鍵をそのまま（構造化複製で）置く。置けなければ投げる（参加の画面が理由を出す）。 */
export async function saveKey(k: CryptoKey): Promise<void> {
  await withStore('readwrite', (s) => s.put(k, KEY_ID));
}
