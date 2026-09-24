const CACHE_NAME = 'anahy-v4';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Si la red no contesta en este tiempo, se abre la copia guardada y la descarga
// sigue en segundo plano. Evita quedarse con la pantalla en blanco esperando
// cuando hay cobertura pero va muy lenta.
const ESPERA_MAX_RED = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Avisos push (los envia scripts/avisos-jornada.js desde GitHub Actions). Llegan aunque la app este cerrada.
self.addEventListener('push', (event) => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) { datos = { cuerpo: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(datos.titulo || 'Anahy', {
    body: datos.cuerpo || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'anahy-jornada-' + (datos.tipo || 'aviso'),
    data: { url: datos.url || './' }
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.location.href).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    for (const v of ventanas) {
      if ('focus' in v) { if (v.navigate) v.navigate(url); return v.focus(); }
    }
    return clients.openWindow(url);
  }));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // No cachear llamadas a Firebase/Firestore: siempre red para datos en tiempo real
  if (url.hostname.includes('firestore') || url.hostname.includes('googleapis') || url.hostname.includes('firebaseio')) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const copia = await cache.match(event.request);

    const red = fetch(event.request).then((response) => {
      // las respuestas de otros dominios llegan "opacas" (sin poder mirar dentro),
      // pero hay que guardarlas igual para que la app funcione sin internet
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(event.request, response.clone()).catch(() => {});
      }
      return response;
    });
    // que el navegador no corte la descarga aunque ya hayamos respondido con la copia
    event.waitUntil(red.catch(() => {}));

    // sin copia guardada no hay alternativa: toca esperar a la red
    if (!copia) return red;

    // con copia: la red tiene unos segundos para responder; si tarda mas,
    // se abre la copia al momento y la version nueva quedara lista para la proxima vez
    try {
      return await Promise.race([
        red,
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('red lenta')), ESPERA_MAX_RED))
      ]);
    } catch (e) {
      return copia;
    }
  })());
});
