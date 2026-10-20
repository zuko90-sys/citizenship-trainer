/* Офлайн для веб-версии (PWA). В сборках Capacitor не регистрируется — там файлы и так локальные.
   VERSION проставляет tools/version-sync.mjs: новая версия — новый кэш, старый удаляется. */
const VERSION = '3.8.0';
const CACHE = `trainer-${VERSION}`;
const CORE = [
  './', './index.html', './manifest.webmanifest',
  `./styles.css?v=${VERSION}`, `./app.js?v=${VERSION}`, `./domain.js?v=${VERSION}`, `./i18n.js?v=${VERSION}`,
  `./data/questions.js?v=${VERSION}`, `./data/rules.js?v=${VERSION}`, `./data/timeline.js?v=${VERSION}`,
  './fonts/firago-regular.woff2', './fonts/firago-medium.woff2', './fonts/firago-semibold.woff2', './fonts/firago-bold.woff2',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // страница — сначала сеть (чтобы подтянуть новую версию), офлайн — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { caches.open(CACHE).then(c => c.put('./index.html', r.clone())); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  // остальное — из кэша, в сеть только за тем, чего в кэше нет
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })));
});
