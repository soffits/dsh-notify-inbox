import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { b64url, encrypt, generateVapidKeys, loadVapidKeys, sendPush, vapidAuthorization } from '../src/webpush.js'

// RFC 8291, Section 5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow (RFC 8291 test vector)
  result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('encryption matches the RFC 8291 example byte for byte', () => {
  const body = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { serverPrivateKey: RFC.asPrivate, salt: b64url.decode(RFC.salt) })
  assert.equal(b64url.encode(body), RFC.result)
})

/** What a browser does with a push body: the receiving side of RFC 8291. */
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(b64url.decode(uaPrivate))
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), b64url.decode(auth), keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const data = body.subarray(21 + idlen)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(data.subarray(data.length - 16))
  const padded = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()])
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')
}

test('a fresh message decrypts on the receiving side, in any script', () => {
  const text = JSON.stringify({ title: '包裹到了', body: 'Le colis est là — 荷物が届きました' })
  const body = encrypt(text, { p256dh: RFC.uaPublic, auth: RFC.auth })
  assert.equal(decrypt(body, RFC.uaPrivate, RFC.auth), text)
})

test('bad subscription keys are refused', () => {
  assert.throws(() => encrypt('x', { p256dh: 'AAAA', auth: RFC.auth }), /p256dh/)
  assert.throws(() => encrypt('x', { p256dh: RFC.uaPublic, auth: 'AAAA' }), /auth secret/)
})

test('VAPID keys round-trip and sign a token the public key verifies', () => {
  const stored = generateVapidKeys()
  const keys = loadVapidKeys(stored)
  assert.equal(keys.publicKey, stored.publicKey)
  const value = vapidAuthorization(keys, 'https://push.example', 'mailto:someone@example.org', Date.UTC(2026, 0, 1))
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(value)
  assert.equal(k, stored.publicKey)
  const [header, claims, signature] = token.split('.')
  assert.deepEqual(JSON.parse(b64url.decode(claims)), { aud: 'https://push.example', exp: Date.UTC(2026, 0, 1) / 1000 + 43200, sub: 'mailto:someone@example.org' })
  const point = b64url.decode(stored.publicKey)
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url.encode(point.subarray(1, 33)), y: b64url.encode(point.subarray(33)) }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64url.decode(signature)))
  const other = generateVapidKeys()
  assert.throws(() => loadVapidKeys({ publicKey: stored.publicKey, privateKey: other.privateKey }), /belong together/)
})

test('sendPush posts the encrypted body with the push headers and reports a gone subscription', async () => {
  const vapid = loadVapidKeys(generateVapidKeys())
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: calls.length === 1 ? 201 : 410 }) }
  const subscription = { endpoint: 'https://push.example/send/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } }
  const first = await sendPush(subscription, { title: 'Hi' }, { vapid, subject: 'mailto:a@example.org', urgency: 'high', fetchImpl })
  assert.deepEqual(first, { ok: true, status: 201, gone: false })
  const { init } = calls[0]
  assert.equal(init.headers.ttl, '86400')
  assert.equal(init.headers.urgency, 'high')
  assert.equal(init.headers['content-encoding'], 'aes128gcm')
  assert.match(init.headers.authorization, /^vapid t=.+, k=/)
  assert.equal(decrypt(init.body, RFC.uaPrivate, RFC.auth), '{"title":"Hi"}')
  const second = await sendPush(subscription, 'x', { vapid, subject: 'mailto:a@example.org', fetchImpl })
  assert.equal(second.gone, true)
})

test('sendPush does not follow a redirect to another address', async () => {
  const hits = []
  const inner = createServer((request, response) => { hits.push(request.url); response.end() })
  await new Promise(resolve => inner.listen(0, '127.0.0.1', resolve))
  const outer = createServer((request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${inner.address().port}/inside` })
    response.end()
  })
  await new Promise(resolve => outer.listen(0, '127.0.0.1', resolve))
  try {
    const vapid = loadVapidKeys(generateVapidKeys())
    const subscription = { endpoint: `http://127.0.0.1:${outer.address().port}/send`, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } }
    const result = await sendPush(subscription, 'x', { vapid, subject: 'mailto:a@example.org' })
    assert.deepEqual([result.ok, result.gone], [false, false])
    assert.deepEqual(hits, [])
  } finally {
    outer.close()
    inner.close()
  }
})
