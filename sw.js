const CACHE_PREFIX = 'iphone-drive-backup-';
const CACHE_NAME = CACHE_PREFIX + 'v12'; // 每次發版：與 index.html / app.js 的 APP_VERSION 一起更新
const APP_SHELL = [
  './', './index.html', './app.js', './md5.js', './zipstream.js', './exifr.full.umd.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'
];
const DL_PREFIX = new URL('./__dl/', self.registration.scope).pathname;

self.addEventListener('install', event => {
  // 不呼叫 skipWaiting：新版先待命，等頁面確認「沒有備份進行中」並按下更新才接手。
  // cache: 'reload' 讓預先快取繞過瀏覽器 HTTP 快取，避免新 SW 配到舊的 index.html / app.js。
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL.map(u => new Request(u, { cache: 'reload' }))))
  );
});

// ===== 串流下載通道 =====
// 頁面把要存的資料（Drive 檔案或即時產生的 ZIP）一段一段透過 MessagePort 交給 SW，
// SW 以「附件下載」回應給瀏覽器，所以大檔案不必先整個放進頁面記憶體（iOS 上大影片因此不容易崩潰）。
// 流量控制：SW 要資料時才發 pull，頁面才讀下一段；瀏覽器寫入磁碟慢，上游就跟著慢。
// 授權金鑰不會傳到 SW：Drive 的下載請求仍由頁面發出。
const dlJobs = new Map(); // id -> { port, filename, size }
const DL_STALL_MS = 5 * 60 * 1000;

function asciiName(name) { return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_') || 'download'; }
function rfc5987(name) { return encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

function serveDownload(id, event) {
  const job = dlJobs.get(id);
  if (!job) return new Response('下載連結已失效，請回到備份中心重新操作。', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  dlJobs.delete(id);
  const port = job.port;
  let pending = null, stallTimer = null, ended = false, finish;
  const done = new Promise(r => { finish = r; });
  event.waitUntil(done); // 串流進行中，不讓 SW 被系統提早終止

  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  const settle = () => { ended = true; clearStall(); const p = pending; pending = null; if (p) p(); finish(); try { port.close(); } catch (e) { /* 忽略 */ } };

  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = e => {
        const m = e.data || {};
        clearStall();
        if (ended) return;
        if (m.type === 'chunk') {
          controller.enqueue(new Uint8Array(m.data));
          const p = pending; pending = null; if (p) p();
        } else if (m.type === 'end') {
          controller.close(); settle();
        } else if (m.type === 'error') {
          controller.error(new Error(m.message || '下載中斷')); settle();
        }
      };
    },
    pull() {
      if (ended) return;
      return new Promise((resolve, reject) => {
        pending = resolve;
        stallTimer = setTimeout(() => { // 頁面被系統暫停或關閉：結束下載，避免永遠卡住
          try { port.postMessage({ type: 'cancel' }); } catch (e) { /* 忽略 */ }
          reject(new Error('頁面沒有回應'));
          settle();
        }, DL_STALL_MS);
        try { port.postMessage({ type: 'pull' }); } catch (e) { reject(e); settle(); }
      });
    },
    cancel() { // 使用者在 iOS 下載清單按了取消
      if (!ended) { try { port.postMessage({ type: 'cancel' }); } catch (e) { /* 忽略 */ } settle(); }
    }
  }, { highWaterMark: 2 * 1024 * 1024, size: chunk => chunk.byteLength });

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName(job.filename)}"; filename*=UTF-8''${rfc5987(job.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  // 已知大小（單檔）時帶上 Content-Length，iOS 下載清單才會顯示進度，檔案被截斷時也會被當成失敗而不是默默存成壞檔
  if (Number.isFinite(job.size) && job.size >= 0) headers.set('Content-Length', String(job.size));
  return new Response(stream, { status: 200, headers });
}

// 只接受來自頁面的明確指令
self.addEventListener('message', event => {
  const d = event.data;
  if (!d) return;
  if (d.action === 'skipWaiting') { self.skipWaiting(); return; }
  const port = event.ports && event.ports[0];
  if (d.action === 'dl-probe' && port) { port.postMessage({ type: 'ready' }); return; }
  if (d.action === 'dl-start' && port && d.id) {
    dlJobs.set(d.id, { port, filename: String(d.filename || 'download'), size: typeof d.size === 'number' ? d.size : null });
    setTimeout(() => { // 30 秒內沒被瀏覽器取用就作廢
      const j = dlJobs.get(d.id);
      if (j) { dlJobs.delete(d.id); try { j.port.postMessage({ type: 'expired' }); } catch (e) { /* 忽略 */ } }
    }, 30000);
    port.postMessage({ type: 'ready' });
  }
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

  if (url.pathname.startsWith(DL_PREFIX)) {
    const id = url.pathname.slice(DL_PREFIX.length).split('/')[0];
    event.respondWith(serveDownload(id, event));
    return;
  }

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
