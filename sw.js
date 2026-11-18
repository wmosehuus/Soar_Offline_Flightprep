/* Offline cache. Bump VERSION whenever any file changes so devices pick up the update. */
const VERSION = 'flightcards-2026-11-18b';
const FILES = ['./', 'index.html', 'app.js', 'core.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
  'fonts/Carlito-Regular.ttf', 'fonts/Carlito-Bold.ttf',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js', 'lib/fontkit.umd.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => new Response('', { status: 404 }))));
});
