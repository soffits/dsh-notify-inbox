import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { createPeople } from '../src/access.js'
import { createActions } from '../src/actions.js'
import { checkSubscription, createPush } from '../src/push.js'
import { createRoutes } from '../src/routes.js'
import { createStore } from '../src/store.js'
import { b64url } from '../src/webpush.js'

const ANA_SUB = 'sub-ana'
const BO_SUB = 'sub-bo'
let dir

const record = (id, extra = {}) => ({
  v: 1, id, person: 'x', time: '2026-11-17T15:00:00Z', lane: 'next-moment', domain: 'orders', title: `Title ${id}`,
  spoken: `Spoken ${id}`, text: `Text ${id}`, links: [], files: [], source: 'test', key: `k-${id}`,
  actions: [{ kind: 'done', id: 'done', label: '', payload: {} }, { kind: 'snooze', id: 'snooze', label: '', payload: {} }],
  test: false, push: true, routed: [{ destination: 'chat', type: 'telegram', ok: true }], ...extra,
})

async function file(person, ...rows) {
  await mkdir(join(dir, person), { recursive: true })
  await appendFile(join(dir, person, 'inbox.jsonl'), rows.map(row => `${typeof row === 'string' ? row : JSON.stringify(row)}\n`).join(''))
}

function setup({ mapping = true, provider = true, events } = {}) {
  let current = null
  const identity = { current: () => current }
  const as = id => { current = id === null ? null : { provider: 'oidc', issuer: 'https://id.example', id } }
  const store = createStore(dir)
  const people = createPeople(mapping ? { people: { [ANA_SUB]: 'Ana', [BO_SUB]: 'bo' } } : {})
  const pushes = []
  const push = createPush({
    dataDir: dir, vapidFile: join(dir, 'keys', 'vapid.json'), subject: 'mailto:a@example.org', perPerson: () => people.enabled, warn: () => {},
    fetchImpl: async (url, init) => { pushes.push({ url, init }); return new Response(null, { status: url.includes('gone') ? 410 : 201 }) },
  })
  const emitted = []
  const actions = createActions({ dataDir: dir, events: () => events ?? { controller: () => ({ emit: input => { emitted.push(input); return { matched: ['job-1'] } } }) }, warn: () => {} })
  const routes = createRoutes({ store, people, push, actions, identity: () => (provider ? identity : undefined), serviceWorker: '/* sw */', pollSeconds: 30 })
  const byPath = new Map(routes.map(route => [route.path, route.fetch]))
  const call = async (path, body) => {
    const [bare] = path.split('?')
    const handler = byPath.get(`/api/notify-inbox/${bare}`)
    const request = new Request(`https://dsh.example/api/notify-inbox/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const response = await handler(request)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.text(), headers: response.headers }
  }
  return { as, call, store, push, pushes, emitted }
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'notify-inbox-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('each person sees only their own inbox; no identity sees nothing; no provider is a 503', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z', lane: 'interrupt' }))
  await file('bo', record('b1'))
  const { as, call } = setup()
  as(ANA_SUB)
  const ana = await call('items')
  assert.deepEqual(ana.body.items.map(item => item.id), ['a2', 'a1'])
  assert.equal(ana.body.items[0].lane, 'interrupt')
  assert.equal((await call('summary')).body.unread, 2)
  as(BO_SUB)
  assert.deepEqual((await call('items')).body.items.map(item => item.id), ['b1'])
  assert.equal((await call('read', { ids: ['a1'] })).status, 200)
  as(ANA_SUB)
  assert.equal((await call('summary')).body.unread, 2, "bo can't mark ana's records read")
  as('stranger')
  assert.deepEqual((await call('items')).body.items, [])
  as(null)
  assert.equal((await call('summary')).body.unread, 0)
  const noProvider = setup({ provider: false })
  assert.equal((await noProvider.call('items')).status, 503)
})

test('a single-owner DSH sees every folder merged', async () => {
  await file('ana', record('a1'))
  await file('bo', record('b1', { time: '2026-11-17T17:00:00Z' }))
  const { call } = setup({ mapping: false, provider: false })
  assert.deepEqual((await call('items')).body.items.map(item => item.id), ['b1', 'a1'])
})

test('read marks: one, all, the unread filter, and new records after mark-all stay unread', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z' }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a1'] })
  assert.deepEqual((await call('items?unread=1')).body.items.map(item => item.id), ['a2'])
  await call('read', { all: true })
  assert.equal((await call('summary')).body.unread, 0)
  await file('ana', record('a3', { time: '2026-11-17T18:00:00Z' }))
  assert.deepEqual((await call('items?unread=1')).body.items.map(item => item.id), ['a3'])
  assert.equal((await call('read', { nothing: true })).status, 400)
})

test('mark unread works on its own and past the mark-all watermark; mark-all clears it again', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z' }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a1'] })
  await call('read', { ids: ['a1'], read: false })
  assert.deepEqual((await call('items?unread=1')).body.items.map(item => item.id), ['a2', 'a1'])
  await call('read', { all: true })
  await call('read', { ids: ['a1'], read: false })
  assert.deepEqual((await call('items?unread=1')).body.items.map(item => item.id), ['a1'])
  await call('read', { ids: ['a1'] })
  assert.equal((await call('summary')).body.unread, 0)
  await call('read', { ids: ['a2'], read: false })
  await call('read', { all: true })
  assert.equal((await call('summary')).body.unread, 0)
})

test('under Unread, rows the page already shows stay as they turn read, done or snoozed', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z' }), record('a3', { time: '2026-11-17T17:00:00Z' }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a1'] })
  await call('action', { record: 'a2', action: 'done' })
  const kept = (await call('items?unread=1&keep=a1,a2,nope/../x')).body.items
  assert.deepEqual(kept.map(item => [item.id, item.read]), [['a3', false], ['a2', true], ['a1', true]])
  assert.deepEqual((await call('items?unread=1')).body.items.map(item => item.id), ['a3'])
})

test('bad lines are skipped and counted, a half-written line waits, a rewritten file is read again', async () => {
  await file('ana', record('a1'), 'not json', JSON.stringify({ id: '../x' }))
  await appendFile(join(dir, 'ana', 'inbox.jsonl'), JSON.stringify(record('a2')).slice(0, 20))
  const { as, call } = setup()
  as(ANA_SUB)
  const summary = (await call('summary')).body
  assert.equal(summary.total, 1)
  assert.equal(summary.problems.badLines, 2)
  await writeFile(join(dir, 'ana', 'inbox.jsonl'), `${JSON.stringify(record('a9'))}\n`)
  assert.deepEqual((await call('items')).body.items.map(item => item.id), ['a9'])
})

test('a done press becomes an action event, is logged, and shows handled once the router says so', async () => {
  await file('ana', record('a1'))
  const { as, call, emitted } = setup()
  as(ANA_SUB)
  const pressed = await call('action', { record: 'a1', action: 'done' })
  assert.equal(pressed.status, 200)
  assert.equal(pressed.body.matched, 1)
  const [event] = emitted
  assert.equal(event.channel, 'ui.action.done')
  assert.equal(event.data.person, 'ana')
  assert.deepEqual(event.data.source, { plugin: 'notify-inbox', record: 'a1', key: 'k-a1', domain: 'orders' })
  assert.equal(event.key, event.data.press)
  const log = (await readFile(join(dir, 'ana', 'actions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log[0].press, event.data.press)
  let [item] = (await call('items')).body.items
  assert.equal(item.read, true)
  assert.equal(item.presses[0].press, event.data.press)
  assert.deepEqual(item.handled, [])
  await file('ana', { v: 1, type: 'handled', record: 'a1', press: event.data.press, action: 'done', result: 'done', time: '2026-11-17T15:01:00Z' })
  ;[item] = (await call('items')).body.items
  assert.equal(item.handled[0].result, 'done')
  assert.equal((await call('summary')).body.total, 1, 'a status line is not a record')
})

test('presses are checked: only declared buttons, only your own records, snooze keeps its time', async () => {
  await file('ana', record('a1'))
  await file('bo', record('b1'))
  const { as, call, emitted } = setup()
  as(ANA_SUB)
  assert.equal((await call('action', { record: 'b1', action: 'done' })).status, 404)
  assert.equal((await call('action', { record: 'a1', action: 'explode' })).status, 400)
  await call('action', { record: 'a1', action: 'snooze', until: '2026-11-18T09:00:00-05:00' })
  assert.equal(emitted[0].data.payload.until, '2026-11-18T09:00:00-05:00')
  const without = setup({ events: {} })
  without.as(ANA_SUB)
  assert.equal((await without.call('action', { record: 'a1', action: 'done' })).body.published, false)
})

test('attachments are served only from the store, by a stored name', async () => {
  await file('ana', record('a1', { files: [{ name: 'photo.png', size: 3, stored: true }, { name: 'big.mov', stored: false, reason: 'too large' }] }))
  await mkdir(join(dir, 'ana', 'files', 'a1'), { recursive: true })
  await writeFile(join(dir, 'ana', 'files', 'a1', 'photo.png'), 'png')
  const { as, call } = setup()
  as(ANA_SUB)
  const ok = await call('file?id=a1&name=photo.png')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  for (const bad of ['file?id=a1&name=big.mov', 'file?id=a1&name=..%2Fread.json', 'file?id=..&name=photo.png']) {
    assert.equal((await call(bad)).status, 404, bad)
  }
  as(BO_SUB)
  assert.equal((await call('file?id=a1&name=photo.png')).status, 404)
})

test('subscriptions must be public HTTPS endpoints', () => {
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } // gitleaks:allow (RFC 8291 test vector)
  assert.equal(checkSubscription({ endpoint: 'https://web.push.apple.com/abc', keys }).endpoint, 'https://web.push.apple.com/abc')
  for (const endpoint of ['http://push.example/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://printer.local/x', 'https://user:pw@push.example/x']) {
    assert.ok(checkSubscription({ endpoint, keys }) instanceof Error, endpoint)
  }
})

/** A browser's side: key pair and auth secret, and decrypting what arrives. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = b64url.encode(Buffer.from('0123456789abcdef'))
  return {
    keys: { p256dh: b64url.encode(ecdh.getPublicKey()), auth },
    open(body) {
      const salt = body.subarray(0, 16)
      const asPublic = body.subarray(21, 21 + body[20])
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), b64url.decode(auth), keyInfo, 32))
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
      const data = body.subarray(21 + body[20])
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(data.subarray(data.length - 16))
      const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()])
      return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'))
    },
  }
}

test('new records are pushed to their person\'s devices only, never the backlog; a gone device is dropped', async () => {
  await file('ana', record('old'))
  await file('bo', record('b0'))
  const { as, call, push, pushes } = setup()
  const phone = browser()
  as(ANA_SUB)
  assert.equal((await call('push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/ana-phone', keys: phone.keys }, label: 'Safari on iOS' })).status, 200)
  assert.equal((await call('push/subscribe', { subscription: { endpoint: 'https://push.example/gone', keys: phone.keys } })).status, 200)
  assert.equal((await call('push/subscribe', { subscription: { endpoint: 'http://push.example/x', keys: phone.keys } })).status, 400)
  assert.equal((await call('push/state', { endpoint: 'https://web.push.apple.com/ana-phone' })).body.subscribed, true)
  await push.scan(['ana', 'bo'])
  assert.equal(pushes.length, 0, 'the backlog is not pushed')
  await file('ana', record('new', { lane: 'interrupt', title: '漏水了', spoken: '厨房传感器湿了。' }), record('quiet', { push: false }))
  await file('bo', record('b1'))
  await push.scan(['ana', 'bo'])
  const toPhone = pushes.filter(p => p.url.includes('ana-phone'))
  assert.equal(toPhone.length, 1)
  assert.equal(toPhone[0].init.headers.urgency, 'high')
  assert.deepEqual(phone.open(toPhone[0].init.body), { title: '漏水了', body: '厨房传感器湿了。', tag: 'new', url: './?notify-inbox=new', urgent: true })
  assert.equal((await call('push/state', { endpoint: 'https://push.example/gone' })).body.subscribed, false, '410 removes it')
  const subs = JSON.parse(await readFile(join(dir, '.push', 'subscriptions.json'), 'utf8'))
  assert.deepEqual(subs.map(sub => [sub.person, sub.label]), [['ana', 'Safari on iOS']])
  const keyFile = await stat(join(dir, 'keys', 'vapid.json'))
  assert.equal(keyFile.mode & 0o777, 0o600)
  pushes.length = 0
  await push.scan(['ana', 'bo'])
  assert.equal(pushes.length, 0, 'nothing twice')
  assert.equal((await call('push/test', { title: 'T', body: 'B' })).body.sent, 1)
})

test('the service worker is served as JavaScript', async () => {
  const { call } = setup()
  const sw = await call('sw.js')
  assert.equal(sw.status, 200)
  assert.match(sw.headers.get('content-type'), /javascript/)
})
