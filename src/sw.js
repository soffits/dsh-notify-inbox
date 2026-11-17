/*
 * Service worker of dsh-notify-inbox, served at /api/notify-inbox/sw.js with
 * the scope /api/notify-inbox/, so it controls no page of the app. It only
 * shows pushed notifications and opens the inbox when one is tapped.
 */
const root = new URL('../../', self.location.href)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function payloadOf(event) {
  try {
    const value = event.data?.json()
    if (value && typeof value === 'object') return value
  } catch {
    // An unreadable payload still shows something.
  }
  return { title: self.location.host, body: '' }
}

self.addEventListener('push', event => {
  const value = payloadOf(event)
  const options = {
    body: typeof value.body === 'string' ? value.body : '',
    data: { url: typeof value.url === 'string' ? value.url : './?notify-inbox=' },
    icon: new URL('icon-192.png', root).href,
    badge: new URL('icon-192.png', root).href,
    requireInteraction: value.urgent === true,
  }
  if (typeof value.tag === 'string' && value.tag !== '') {
    options.tag = value.tag
    options.renotify = true
  }
  event.waitUntil(self.registration.showNotification(typeof value.title === 'string' && value.title ? value.title : self.location.host, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  let target = root.href
  try {
    const url = new URL(event.notification.data?.url ?? './', root)
    if (url.origin === root.origin) target = url.href
  } catch {
    // Keep the app root.
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(client => new URL(client.url).origin === root.origin)
    if (open !== undefined) {
      open.postMessage({ type: 'notify-inbox/open', url: target })
      await open.focus()
      return
    }
    await self.clients.openWindow(target)
  })())
})

self.addEventListener('pushsubscriptionchange', event => {
  const old = event.oldSubscription?.endpoint
  event.waitUntil((async () => {
    const post = (path, value) => fetch(new URL(path, self.location.href), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
    let next = event.newSubscription
    if (!next) {
      const config = await (await fetch(new URL('push/config', self.location.href), { credentials: 'same-origin' })).json()
      const base64 = config.publicKey.replaceAll('-', '+').replaceAll('_', '/')
      const raw = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
      next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) })
    }
    await post('push/subscribe', { subscription: next.toJSON(), label: 'renewed' })
    if (old !== undefined && old !== next.endpoint) await post('push/unsubscribe', { endpoint: old })
  })().catch(() => {}))
})
