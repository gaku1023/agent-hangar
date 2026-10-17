/**
 * スマホの手元の置き場。
 *
 * Worker 用のトークンと接続先は localStorage に置く。
 * スマホの鍵ペア（ECDH P-256）の秘密鍵と、スマホ用の鍵 M（世代つき）は、取り出せない（non-extractable）CryptoKey のまま IndexedDB に置く。
 * 鍵ペアが X25519 でないのは、WebKit が X25519 の CryptoKey を IndexedDB から読み戻すと null にするためである（WebKit bug 312279）。
 * 画面に XSS があっても、鍵の値そのものは持ち出せない（使うことはできても、写して外へ送れない）。
 * どちらの置き場も、プライベートブラウズやサイトデータの消去で投げたり空になったりするので、読み書きは全部 try/catch で包む。
 */

export type Pairing = { url: string; token: string; deviceId: string };

/** スマホの鍵ペア。pub は P-256 の raw の非圧縮点（65 バイト）の base64url、key は取り出せない秘密鍵。 */
export type PhonePair = { pub: string; key: CryptoKey };

/** 手元のスマホ用の鍵。世代の番号から AES-GCM の鍵を引く。 */
export type Keyring = ReadonlyMap<number, CryptoKey>;

/** 封じるときに使う、世代つきのスマホ用の鍵。 */
export type PhoneKey = { epoch: number; key: CryptoKey };

/**
 * 手元に残すスマホ用の鍵の世代の数。
 * スマホを解除すると PC は M を次の世代にするが、まだ前の世代で封じた素や依頼の答えが少しの間残るので、新しいほうからいくつかを残す。
 */
export const KEEP_EPOCHS = 3;

const PAIRING_KEY = 'hangar.mobile.pairing';
const DB_NAME = 'hangar-mobile';
const DB_STORE = 'keys';
/** 互換の版 8 までの、QR で渡された 1 本の鍵。今は使わず、接続を忘れるときに消す。 */
const LEGACY_KEY_ID = 'mobile-key';
const PAIR_ID = 'phone-pair';
const KEYS_ID = 'phone-keys';

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

/**
 * 接続を忘れる。鍵ペアとスマホ用の鍵も IndexedDB から消す。
 * 呼び手は終わるのを待たなくてよい（消せなくても、Worker がトークンを 401 で断るので受信箱は開けない）。
 */
export function clearPairing(): Promise<void> {
  try {
    localStorage.removeItem(PAIRING_KEY);
  } catch {
    // 消せなくても、Worker がトークンを 401 で断るので受信箱は開けない。
  }
  return withStore('readwrite', (s) => {
    s.delete(LEGACY_KEY_ID);
    s.delete(PAIR_ID);
    return s.delete(KEYS_ID);
  }).then(
    () => undefined,
    () => undefined,
  );
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

export async function loadPhonePair(): Promise<PhonePair | null> {
  try {
    const v = (await withStore('readonly', (s) => s.get(PAIR_ID))) as Partial<PhonePair> | undefined;
    return v && typeof v.pub === 'string' && v.key instanceof CryptoKey ? { pub: v.pub, key: v.key } : null;
  } catch {
    return null;
  }
}

/** 鍵ペアをそのまま（構造化複製で）置く。置けなければ投げる（参加の画面が理由を出す）。 */
export async function savePhonePair(p: PhonePair): Promise<void> {
  await withStore('readwrite', (s) => s.put({ pub: p.pub, key: p.key }, PAIR_ID));
}

function readKeys(v: unknown): Map<number, CryptoKey> {
  const out = new Map<number, CryptoKey>();
  if (!Array.isArray(v)) return out;
  for (const e of v as unknown[]) {
    const o = e as { epoch?: unknown; key?: unknown } | null;
    if (o && Number.isSafeInteger(o.epoch) && (o.epoch as number) > 0 && o.key instanceof CryptoKey) out.set(o.epoch as number, o.key);
  }
  return out;
}

/** 手元のスマホ用の鍵。読めなければ空。 */
export async function loadPhoneKeys(): Promise<Keyring> {
  try {
    return readKeys(await withStore('readonly', (s) => s.get(KEYS_ID)));
  } catch {
    return new Map();
  }
}

/** スマホ用の鍵 M[epoch] を足し、新しいほうから KEEP_EPOCHS 世代だけを残す。足した後の手元の鍵を返す。置けなければ投げる。 */
export async function savePhoneKey(epoch: number, key: CryptoKey): Promise<Keyring> {
  const ring = new Map(await loadPhoneKeys());
  ring.set(epoch, key);
  const kept = [...ring.entries()].sort((a, b) => b[0] - a[0]).slice(0, KEEP_EPOCHS);
  await withStore('readwrite', (s) => s.put(kept.map(([e, k]) => ({ epoch: e, key: k })), KEYS_ID));
  return new Map(kept);
}

/** スマホ用の鍵をすべて忘れる（接続し直したとき。前の接続先の世代と番号が重ならないように）。 */
export async function clearPhoneKeys(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(KEYS_ID));
}

/** いちばん新しい世代の番号。鍵が無ければ 0。 */
export function newestEpoch(ring: Keyring): number {
  let n = 0;
  for (const e of ring.keys()) if (e > n) n = e;
  return n;
}

/** 封じるときに使う、いちばん新しい世代の鍵。無ければ null。 */
export function currentKey(ring: Keyring): PhoneKey | null {
  const epoch = newestEpoch(ring);
  const key = ring.get(epoch);
  return key ? { epoch, key } : null;
}
