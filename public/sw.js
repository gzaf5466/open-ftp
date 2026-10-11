const CACHE_NAME = 'sendanywhere-lan-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/css/base.css',
  '/css/components.css',
  '/css/send-receive.css',
  '/css/vault.css',
  '/css/radar.css',
  '/js/sounds.js',
  '/js/api.js',
  '/js/p2p.js',
  '/js/websocket.js',
  '/js/preview.js',
  '/js/qr-scanner.js',
  '/js/send.js',
  '/js/receive.js',
  '/js/vault.js',
  '/js/peers.js',
  '/js/ftp.js',
  '/js/logs.js',
  '/js/app.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only cache GET static assets, bypass API endpoints
  if (e.request.method === 'GET' && !e.request.url.includes('/api/') && !e.request.url.includes('/ws')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
