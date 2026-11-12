const CACHE_NAME = 'loop-scheduler-mobile-v11';
const APP_SHELL = [
  './',
  './mujian-scheduler.html',
  './cloud-config.js',
  './cloud-sync.js',
  './supabase-client.js',
  './manifest.webmanifest',
  './app-icon.svg',
  './app-icon-180.png',
  './app-icon-192.png',
  './app-icon-512.png'
];
const APP_PATHS = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).pathname));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !APP_PATHS.has(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
