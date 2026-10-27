const CACHE = 'stellanova-shell-v3'
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/manus-routes.json']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('nftgram-shell-') || key.startsWith('stellanova-shell-')).filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]))
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  // API responses are live user data. Never cache them, especially error
  // responses from a cold-starting database or temporary network outage.
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return
  // Always request the current app document after a deploy. Cache-first HTML
  // can pin a phone to an old bundle indefinitely, even after the new worker
  // has activated. Keep the cached shell only as an offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/')),
    )
    return
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const clone = response.clone()
        caches.open(CACHE).then((cache) => cache.put(event.request, clone))
      }
      return response
    }).catch(() => {
      if (event.request.destination === 'image') {
        return new Response('', { status: 503, statusText: 'Offline image unavailable' })
      }
      return caches.match('/')
    }))
  )
})

self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch { payload = { body: event.data?.text() ?? '' } }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'StellaNova activity'
  const body = typeof payload.body === 'string' ? payload.body : 'There is new activity on StellaNova.'
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/account'
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url },
    tag: `stellanova-${Date.now()}`,
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const requestedUrl = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/account'
  const target = new URL(requestedUrl, self.location.origin)
  if (target.origin !== self.location.origin) target.href = new URL('/account', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('focus' in client) {
        if ('navigate' in client) await client.navigate(target.href)
        return client.focus()
      }
    }
    return self.clients.openWindow(target.href)
  })())
})
