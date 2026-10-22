const CACHE_NAME = 'iphone-drive-backup-v2.1'; // 版本號必須改，才會觸發更新
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  self.skipWaiting(); // 強制新版 Service Worker 立刻進入等待狀態
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    }).then(() => self.clients.claim()) // 立刻接管目前的頁面
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  
  // 改為 Network First (網路優先)，確保能抓到最新版
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});