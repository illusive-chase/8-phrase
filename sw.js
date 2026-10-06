// Service Worker：预缓存整个应用，离线可用。
// 每次发布新版本都要把 VERSION 加 1，否则用户手机上会一直是旧版本。
const VERSION = 1;
const CACHE = `8p-v${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/player.js',
  './js/recorder.js',
  './js/recorder-worklet.js',
  './js/process.js',
  './js/fit-text.js',
  './js/wakelock.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('8p-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // 导航：先查缓存里的页面，没有再走网络，离线时退回 index.html
    event.respondWith(
      caches
        .match(request, { ignoreSearch: true })
        .then((hit) => hit || fetch(request))
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
});
