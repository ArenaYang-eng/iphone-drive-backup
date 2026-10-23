const CACHE_PREFIX = 'iphone-drive-backup-';
const CACHE_NAME = CACHE_PREFIX + 'v10'; // 每次發版：與 index.html / app.js 的 APP_VERSION 一起更新
const APP_SHELL = [
  './', './index.html', './app.js', './exifr.full.umd.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', event => {
  // 不呼叫 skipWaiting：新版先待命，等頁面確認「沒有備份進行中」並按下更新才接手。
  // cache: 'reload' 讓預先快取繞過瀏覽器 HTTP 快取，避免新 SW 配到舊的 index.html / app.js。
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))))
  );
});

// 只接受來自頁面的明確指令
self.addEventListener('message', event => {
  if (event.data && event.data.action === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 網路優先、離線時退回本版快取
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        // waitUntil：確保回應送出後 SW 不會在寫入快取前被終止
        event.waitUntil(caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      // 只查本版快取；用 caches.match() 會連「待命中的舊版」快取一起查，可能回傳舊檔
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
