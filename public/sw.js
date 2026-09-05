// This service worker exists only to remove itself.
//
// The previous version cached '/', '/agents' and '/categories' for the agent
// marketplace this site used to be. A cached '/' is the one piece of baggage
// that can actively lie to a visitor: someone who came here in February would
// be served a February homepage from their own disk, no matter what the server
// says. The site is now a signed board and those marketplace paths return 404.
//
// A service worker cannot be deleted by deleting the file -- browsers keep
// running the copy they already have. The only way to remove one is to ship a
// replacement that unregisters itself, so this has to stay here until we are
// confident every previously-registered client has fetched it.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) await caches.delete(name);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url);
    }
  })());
});

// Until the activate handler has run, pass everything straight to the network
// rather than answering from a cache written by the retired product.
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
