// スマホの画面のサービスワーカー。ホーム画面のアプリとして入れられるようにするためのもの。
// 画面の殻（/app/ の下）だけを、先に網から取り、取れないときだけ手元の写しを返す。
// 受信箱や起動の依頼（/m/）は写さない。中身は封じてあるが、古い一覧を出さないため。
// もう 1 つの仕事は、Web Push で来たスマホの通知を開いて出すことである（push と notificationclick）。
const CACHE = 'hangar-app-v1';
const SCOPE = new URL('./', self.location.href).pathname;

// スマホの通知。
// PC はスマホ用の鍵 M[世代] で通知の中身を封じ（shared の sealPhoneNotice）、Worker は封じたまま Web Push の本文にする。
// このファイルは素の JS で shared の TS を読めないので、同じ手順をここに書き直す（src/sw.test.ts が shared で封じたものを開けることを確かめる）。
// 封じた文字列は `<世代>.<base64url(iv(12) || AES-256-GCM の暗号文とタグ)>`、AAD は JSON の ["phone-notice", 世代]、中身は { title, pcName, sessionId, count } の JSON である。
// 鍵は画面（src/store.ts）が IndexedDB に置いた取り出せない CryptoKey を読む。DB の名前と形は store.ts と同じにする。
const DB_NAME = 'hangar-mobile';
const DB_STORE = 'keys';
const KEYS_ID = 'phone-keys';
const NOTICE_RE = /^([1-9][0-9]{0,8})\.([A-Za-z0-9_-]+)$/;
const IV_LEN = 12;
const TAG_LEN = 16;
// 開けないとき（鍵が無い、世代が合わない、壊れている）の文。
// iOS は push を受けて通知を出さないと購読を取り消すので、黙って捨てずに必ずこの文で出す。
const GENERIC = { title: 'hangar', body: 'hangar に新しい知らせがあります', sessionId: null };

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** store.ts の openDb と同じ。DB が無ければ同じ形で作る（版や器を変えると画面の側が読めなくなる）。 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = self.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

/** 手元のスマホ用の鍵 M[epoch]。無ければ null。 */
async function phoneKey(epoch) {
  const db = await openDb();
  try {
    const list = await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(KEYS_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!Array.isArray(list)) return null;
    const hit = list.find((e) => e && e.epoch === epoch && e.key);
    return hit ? hit.key : null;
  } finally {
    db.close();
  }
}

/** 封じた通知を開く。開けなければ null。 */
async function openNotice(sealed) {
  try {
    const m = typeof sealed === 'string' ? NOTICE_RE.exec(sealed) : null;
    if (!m) return null;
    const epoch = Number(m[1]);
    const raw = fromBase64Url(m[2]);
    if (raw.length < IV_LEN + TAG_LEN) return null;
    const key = await phoneKey(epoch);
    if (!key) return null;
    const aad = new TextEncoder().encode(JSON.stringify(['phone-notice', epoch]));
    const plain = await self.crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, IV_LEN), additionalData: aad }, key, raw.subarray(IV_LEN));
    const v = JSON.parse(new TextDecoder().decode(plain));
    if (!v || typeof v !== 'object' || typeof v.title !== 'string' || typeof v.pcName !== 'string' || typeof v.sessionId !== 'string') return null;
    if (!Number.isSafeInteger(v.count) || v.count < 1) return null;
    return v;
  } catch {
    return null;
  }
}

/** 通知の見出しと本文。受信箱の要対応の文と、用語集の「ほか N 件」に合わせる。 */
function noticeText(v) {
  const title = v.title.trim() || 'hangar';
  const pc = v.pcName.trim();
  return {
    title: v.count >= 2 ? `${title} ほか ${v.count - 1} 件` : title,
    body: pc ? `${pc} で入力を待っています` : '入力を待っています',
    sessionId: v.sessionId,
  };
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let sealed = null;
      try {
        sealed = event.data ? event.data.text() : null;
      } catch {
        sealed = null;
      }
      const v = await openNotice(sealed);
      const t = v ? noticeText(v) : GENERIC;
      const options = { body: t.body, icon: `${SCOPE}icon-192.png`, data: { sessionId: t.sessionId } };
      // 同じ会話の知らせは重ねて 1 つにし、また要対応に入ったら鳴らし直す。
      if (t.sessionId) Object.assign(options, { tag: `session:${t.sessionId}`, renotify: true });
      await self.registration.showNotification(t.title, options);
    })(),
  );
});

// 通知を押したら、受信箱のその会話の行を開く。
// 開いている hangar があれば前に出して会話の ID を渡し（画面は message の hangar-open を待つ）、無ければ #open=<ID> を付けて開く（main.tsx が読む）。
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const id = data && typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
  const url = new URL(id ? `${SCOPE}#open=${encodeURIComponent(id)}` : SCOPE, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if (!new URL(c.url).pathname.startsWith(SCOPE)) continue;
        if (id) c.postMessage({ type: 'hangar-open', sessionId: id });
        if (typeof c.focus === 'function') return c.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') await cache.put(req.mode === 'navigate' ? SCOPE : req, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(req.mode === 'navigate' ? SCOPE : req);
        if (hit) return hit;
        throw e;
      }
    })(),
  );
});
