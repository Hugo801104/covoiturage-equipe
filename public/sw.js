/* Service worker : met en cache les fichiers de l'application pour un fonctionnement 100 % hors ligne.
   La version du cache est remplacée à la compilation (__BUILD__). Aucune donnée utilisateur n'y transite. */
const CACHE = 'covoiturage-__BUILD__';
const FILES = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html'))));
});
