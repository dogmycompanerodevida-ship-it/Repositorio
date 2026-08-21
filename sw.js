// DogMy Service Worker - Cache para PWA
const CACHE_NAME = 'dogmy-v7.8';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './admin.html',
  './agenda.html',
  './cliente.html',
  './lista_clientes.html',
  './paseador.html',
  './registro.html',
  './style.css',
  './script.js',
  './firebase-config.js',
  './logo.jpg',
  './manifest.json'
];

// Archivos que SIEMPRE deben pedirse primero a la red (para que las
// actualizaciones se vean de inmediato). Solo se usa la copia en cache
// si no hay internet en ese momento.
const SIEMPRE_RED_PRIMERO = ['.html', '.js', '.css', '.json'];

// Instalar: guardar archivos en cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activar: limpiar caches viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener('fetch', event => {
  // No cachear peticiones a Firebase (APIs externas)
  if (event.request.url.includes('firebase') ||
      event.request.url.includes('gstatic') ||
      event.request.url.includes('openstreetmap') ||
      event.request.url.includes('unpkg')) {
    return;
  }

  const esArchivoDeApp = SIEMPRE_RED_PRIMERO.some(ext => event.request.url.includes(ext)) ||
                         event.request.mode === 'navigate';

  if (esArchivoDeApp) {
    // RED PRIMERO: intenta traer la version mas nueva; si no hay internet, usa la de cache
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => {
        return caches.match(event.request).then(response => {
          if (response) return response;
          if (event.request.mode === 'navigate') return caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Resto de archivos (imagenes, iconos): cache primero, mas rapido
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;
      return fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
