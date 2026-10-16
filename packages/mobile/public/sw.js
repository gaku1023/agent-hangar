// スマホの画面のサービスワーカー。ホーム画面のアプリとして入れられるようにするためのもの。
// 画面の殻（/app/ の下）だけを、先に網から取り、取れないときだけ手元の写しを返す。
// 受信箱や起動の依頼（/m/）は写さない。中身は封じてあるが、古い一覧を出さないため。
const CACHE = 'hangar-app-v1';
const SCOPE = new URL('./', self.location.href).pathname;

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
