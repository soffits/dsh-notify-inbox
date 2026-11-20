/**
 * Web Push on node:crypto: message encryption (RFC 8291, aes128gcm from
 * RFC 8188) and the application server's VAPID identity (RFC 8292).
 *
 * The push service only ever sees the encrypted body; the browser decrypts
 * it with the keys it handed out when it subscribed.
 */
import { createECDH, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'

const RECORD_SIZE = 4096
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

export const b64url = {
  encode: buffer => Buffer.from(buffer).toString('base64url'),
  decode: text => Buffer.from(String(text).replace(/\s+/g, ''), 'base64url'),
}

/** A fresh VAPID key pair: the raw uncompressed public point and the private scalar, base64url. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  return { publicKey: publicFromJwk(jwk), privateKey: jwk.d }
}

function publicFromJwk(jwk) {
  return b64url.encode(Buffer.concat([Buffer.from([4]), b64url.decode(jwk.x), b64url.decode(jwk.y)]))
}

/** Check a stored key pair and return it ready for signing; throws when it is not a P-256 pair. */
export function loadVapidKeys({ publicKey, privateKey }) {
  const point = b64url.decode(publicKey)
  if (point.length !== 65 || point[0] !== 4) throw new Error('VAPID public key is not an uncompressed P-256 point')
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url.encode(point.subarray(1, 33)), y: b64url.encode(point.subarray(33)) }
  const derived = createECDH('prime256v1')
  derived.setPrivateKey(b64url.decode(privateKey))
  if (!derived.getPublicKey().equals(point)) throw new Error('VAPID keys do not belong together')
  return { publicKey: b64url.encode(point), key: createPrivateKey({ key: jwk, format: 'jwk' }) }
}

/** The `Authorization` header value for one push service origin. */
export function vapidAuthorization(keys, audience, subject, now = Date.now()) {
  const header = b64url.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS, sub: subject }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${keys.publicKey}`
}

/**
 * Encrypt one push message for a subscription's keys.
 * `serverKeys` and `salt` are for tests; normally both are fresh per message.
 * @param {Buffer|string} plaintext
 * @param {{ p256dh: string, auth: string }} subscriptionKeys - base64url, as the browser gives them
 */
export function encrypt(plaintext, subscriptionKeys, { serverPrivateKey, salt = randomBytes(16) } = {}) {
  const uaPublic = b64url.decode(subscriptionKeys.p256dh)
  const authSecret = b64url.decode(subscriptionKeys.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('subscription p256dh is not an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('subscription auth secret is not 16 bytes')
  const ecdh = createECDH('prime256v1')
  if (serverPrivateKey === undefined) ecdh.generateKeys()
  else ecdh.setPrivateKey(b64url.decode(serverPrivateKey))
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body])
}

/**
 * Send one message. Resolves `{ ok, status }`; `gone` is true when the push
 * service says the subscription no longer exists (404, 410).
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {ReturnType<typeof loadVapidKeys>} vapid
 */
export async function sendPush(subscription, payload, { vapid, subject, ttl = 86400, urgency = 'normal', topic, fetchImpl = fetch, timeoutMs = 10000 }) {
  const url = new URL(subscription.endpoint)
  const headers = {
    authorization: vapidAuthorization(vapid, url.origin, subject),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttl),
    urgency,
  }
  if (topic !== undefined) headers.topic = topic
  const response = await fetchImpl(url.href, {
    method: 'POST',
    headers,
    body: encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  await response.arrayBuffer().catch(() => undefined)
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 }
}
