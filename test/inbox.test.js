import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { createPeople } from '../src/access.js'
import { createChanges } from '../src/changes.js'
import { domainMap } from '../src/domains.js'
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

function setup({ mapping = true, provider = true, quiet = [] } = {}) {
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
  const changes = createChanges({ dataDir: dir, persons: () => store.persons() })
  const routes = createRoutes({ store, people, push, changes, strings: async () => ({ en: { title: 'Inbox' } }), identity: () => (provider ? identity : undefined), serviceWorker: '/* sw */', domains: domainMap({ legal: { icon: 'scale', tone: 'violet' } }), summaryHours: 12, quiet })
  const byPath = new Map(routes.map(route => [route.path, route.fetch]))
  const call = async (path, body) => {
    const [bare] = path.split('?')
    const handler = byPath.get(`/api/notify-inbox/${bare}`)
    const request = new Request(`https://dsh.example/api/notify-inbox/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const response = await handler(request)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.text(), headers: response.headers }
  }
  return { as, call, store, push, pushes, changes, byPath }
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

const unreadIds = async call => (await call('items')).body.items.filter(item => !item.read).map(item => item.id)

test('read marks: one, all, and new records after mark-all stay unread', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z' }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a1'] })
  assert.deepEqual(await unreadIds(call), ['a2'])
  await call('read', { all: true })
  assert.equal((await call('summary')).body.unread, 0)
  await file('ana', record('a3', { time: '2026-11-17T18:00:00Z' }))
  assert.deepEqual(await unreadIds(call), ['a3'])
  assert.equal((await call('read', { nothing: true })).status, 400)
})

test('mark unread works on its own and past the mark-all watermark; mark-all clears it again', async () => {
  await file('ana', record('a1'), record('a2', { time: '2026-11-17T16:00:00Z' }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a1'] })
  await call('read', { ids: ['a1'], read: false })
  assert.deepEqual(await unreadIds(call), ['a2', 'a1'])
  await call('read', { all: true })
  await call('read', { ids: ['a1'], read: false })
  assert.deepEqual(await unreadIds(call), ['a1'])
  await call('read', { ids: ['a1'] })
  assert.equal((await call('summary')).body.unread, 0)
  await call('read', { ids: ['a2'], read: false })
  await call('read', { all: true })
  assert.equal((await call('summary')).body.unread, 0)
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
  await writeFile(join(dir, 'ana', 'inbox.jsonl'), `${JSON.stringify(record('a7', { title: 'A much longer title than before, so the rewritten file is bigger' }))}\n${JSON.stringify(record('a8'))}\n`)
  assert.deepEqual((await call('items')).body.items.map(item => item.id).sort(), ['a7', 'a8'], 'a file rewritten in place and grown is read again')
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

test('a thread is one item: the newest on top, the older ones as its history, read only when all are', async () => {
  await file('ana',
    record('m1', { time: '2026-11-17T15:00:00Z', thread: 'todo-42', title: 'Reminder', spoken: 'Today, left side' }),
    record('x1', { time: '2026-11-17T16:00:00Z', actions: [] }),
    record('m2', { time: '2026-11-17T18:30:00Z', thread: 'todo-42', title: 'Still open', spoken: 'Second reminder' }))
  await file('bo', record('b1', { thread: 'todo-42' }))
  const { as, call } = setup({ mapping: false, provider: false })
  as(null)
  const items = (await call('items')).body.items
  const thread = items.find(item => item.thread === 'todo-42' && item.person === 'ana')
  assert.equal(thread.id, 'm2')
  assert.deepEqual(thread.ids, ['m2', 'm1'])
  assert.deepEqual(thread.history.map(row => [row.id, row.title]), [['m1', 'Reminder']])
  assert.match(thread.key, /^t-[0-9a-f]{20}$/)
  assert.equal(items.length, 3, "bo's thread of the same name is bo's own item")
  await call('read', { ids: ['m2'] })
  assert.equal((await call('items')).body.items.find(item => item.key === thread.key).read, false)
  await call('read', { ids: thread.ids })
  assert.equal((await call('items')).body.items.find(item => item.key === thread.key).read, true)
})

test('groups come from the writer, else from lane and buttons; counts, the summary line and the domain map', async () => {
  const soon = new Date(Date.now() + 3600 * 1000).toISOString()
  const past = new Date(Date.now() - 3600 * 1000).toISOString()
  await file('ana',
    record('n1', { lane: 'interrupt', actions: [] }),
    record('i1', { actions: [{ kind: 'step', id: 's', label: 'Plan it', payload: {} }] }),
    record('h1', { actions: [], handled: { text: 'Asked again; follow-up set.' } }),
    record('l1', { actions: [], thread: 'flight', live: { until: soon, progress: { from: past, to: soon } } }),
    record('l2', { actions: [], thread: 'job', attention: 'live', live: { until: past } }),
    record('e1', { attention: 'info' }))
  await writeFile(join(dir, 'ana', 'summary.json'), JSON.stringify({ v: 1, text: 'Two things need you.', at: new Date().toISOString() }))
  const { as, call } = setup()
  as(ANA_SUB)
  const items = (await call('items')).body.items
  const by = Object.fromEntries(items.map(item => [item.id, item]))
  assert.deepEqual(Object.entries(by).map(([id, item]) => [id, item.group]).sort(), [['e1', 'info'], ['h1', 'handled'], ['i1', 'info'], ['l1', 'live'], ['l2', 'info'], ['n1', 'urgent']])
  assert.deepEqual([by.l1.liveNow, by.l2.liveNow, by.l2.moved], [true, false, 'ended'])
  assert.deepEqual(by.h1.handled, { text: 'Asked again; follow-up set.' })
  assert.deepEqual(by.l1.live.progress, { from: past, to: soon })
  const summary = (await call('summary')).body
  assert.deepEqual(summary.groups, { urgent: 1, live: 1, handled: 1, info: 3 })
  assert.equal(summary.line.text, 'Two things need you.')
  assert.deepEqual([summary.domains.legal, summary.domains.travel], [{ icon: 'scale', tone: 'violet' }, { icon: 'plane' }])
  await writeFile(join(dir, 'ana', 'summary.json'), JSON.stringify({ text: 'Old news.', at: '2026-01-01T00:00:00Z' }))
  assert.equal((await call('summary')).body.line, null, 'an old summary line is not shown')
})

test('the events stream tells an open page when its own inbox changed, and only then', async () => {
  await file('ana', record('a1'))
  await file('bo', record('b1'))
  const { as, byPath, changes } = setup()
  await changes.start()
  as(ANA_SUB)
  const abort = new AbortController()
  const response = await byPath.get('/api/notify-inbox/events')(new Request('https://dsh.example/api/notify-inbox/events', { signal: abort.signal }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  let pending = null
  const until = async (pattern, ms = 2000) => {
    const end = Date.now() + ms
    while (!pattern.test(seen) && Date.now() < end) {
      pending ??= reader.read()
      const chunk = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 50))])
      if (chunk === null) continue
      pending = null
      if (chunk.value) seen += decoder.decode(chunk.value)
    }
    return pattern.test(seen)
  }
  try {
    assert.ok(await until(/: open/))
    await new Promise(resolve => setTimeout(resolve, 60))
    await file('bo', record('b2'))
    assert.equal(await until(/"type":"change"/, 200), false, "bo's change is not ana's news")
    await file('ana', record('a2'))
    assert.ok(await until(/"type":"change"/))
    seen = ''
    await writeFile(join(dir, 'ana', 'asks.json'), '{}')
    assert.equal(await until(/"type":"change"/, 200), false, 'a file that is not part of the inbox is no news')
  } finally {
    abort.abort()
    changes.stop()
  }
})

test('the words are read for each request and never cached', async () => {
  const { as, call } = setup()
  as(ANA_SUB)
  const got = await call('strings')
  assert.equal(got.headers.get('cache-control'), 'no-store')
  assert.equal(got.body.tables.en.title, 'Inbox')
})

test('a quiet person gets a dot, never a count, on the bell', async () => {
  await file('ana', record('a1'))
  await file('bo', record('b1'))
  const { as, call } = setup({ quiet: ['Bo'] })
  as(BO_SUB)
  const bo = (await call('summary')).body
  assert.equal(bo.badge, 'dot')
  assert.equal(bo.unread, 1)
  as(ANA_SUB)
  assert.equal((await call('summary')).body.badge, 'count')
})

test('All lists items strictly by time, newest first, whatever group they are in', async () => {
  const at = minutes => new Date(Date.parse('2026-11-17T15:00:00Z') + minutes * 60000).toISOString()
  await file('ana',
    record('old-urgent', { lane: 'interrupt', actions: [], time: at(0) }),
    record('mid-info', { attention: 'info', time: at(10) }),
    record('new-handled', { actions: [], handled: { text: 'Done.' }, time: at(20) }),
    record('newest-info', { attention: 'info', time: at(30) }))
  const { as, call } = setup()
  as(ANA_SUB)
  const all = (await call('items')).body.items
  assert.deepEqual(all.map(item => item.id), ['newest-info', 'new-handled', 'mid-info', 'old-urgent'])
  assert.deepEqual((await call('items?view=all')).body.items.map(item => item.id), all.map(item => item.id))
  const page = await call('items?limit=2')
  assert.deepEqual(page.body.items.map(item => item.id), ['newest-info', 'new-handled'])
  assert.deepEqual((await call(`items?limit=2&before=${page.body.items[1].key}`)).body.items.map(item => item.id), ['mid-info', 'old-urgent'])
})

test('Unread lists only unread items in time order, and keeps what the page already shows as it is read', async () => {
  const at = minutes => new Date(Date.parse('2026-11-17T15:00:00Z') + minutes * 60000).toISOString()
  await file('ana',
    record('a1', { attention: 'info', time: at(0) }),
    record('a2', { lane: 'interrupt', actions: [], time: at(10) }),
    record('a3', { attention: 'info', time: at(20) }),
    record('a4', { attention: 'info', time: at(30) }))
  const { as, call } = setup()
  as(ANA_SUB)
  await call('read', { ids: ['a3'] })
  const shown = (await call('items?view=unread')).body.items
  assert.deepEqual(shown.map(item => item.id), ['a4', 'a2', 'a1'])
  assert.equal((await call('summary')).body.unread, 3)
  await call('read', { ids: ['a2'] })
  assert.deepEqual((await call('items?view=unread')).body.items.map(item => item.id), ['a4', 'a1'])
  const keep = shown.map(item => item.key).join(',')
  assert.deepEqual((await call(`items?view=unread&keep=${keep}`)).body.items.map(item => item.id), ['a4', 'a2', 'a1'], 'a read item stays where it was until the view is left')
})


test('the inbox holds notices: a record about an ask is an ordinary item with no buttons, and an asks file beside it is not read', async () => {
  await file('ana',
    record('a1', { attention: 'needs-you', thread: 'todo:u1', todo: 'u1', session: 'session-abc' }),
    record('a2', { attention: 'needs-you', lane: 'interrupt', time: '2026-11-17T15:01:00Z' }))
  await writeFile(join(dir, 'ana', 'asks.json'), JSON.stringify({ v: 1, person: 'ana', asks: [{ id: 'todo:u2', title: 'Pick one', time: '2026-11-17T15:00:00Z', actions: [] }] }))
  const { as, call, byPath } = setup()
  as(ANA_SUB)
  const { items } = (await call('items')).body
  assert.deepEqual(items.map(item => [item.id, item.group]), [['a2', 'urgent'], ['a1', 'info']])
  assert.equal(items[1].ask, undefined)
  const { groups } = (await call('summary')).body
  assert.deepEqual(groups, { urgent: 1, live: 0, handled: 0, info: 1 })
  assert.equal(byPath.has('/api/notify-inbox/reply'), false, 'there is no reply box to answer from')
  assert.equal(items[1].actions, undefined, 'a notice carries no buttons, whatever its writer filed')
  for (const route of ['action', 'undo']) assert.equal(byPath.has(`/api/notify-inbox/${route}`), false)
})

test('an inbox that appears after the first scan is pushed from its first record', async () => {
  await file('ana', record('old'))
  const { as, call, push, pushes } = setup()
  const phone = browser()
  as(BO_SUB)
  await call('push/subscribe', { subscription: { endpoint: 'https://push.example/bo-phone', keys: phone.keys } })
  await push.scan(['ana'])
  await file('bo', record('first'))
  await push.scan(['ana', 'bo'])
  assert.equal(pushes.filter(p => p.url.includes('bo-phone')).length, 1)
})

test('a person with no inbox mapping cannot see, remove or test the ownerless subscriptions of owner mode', async () => {
  const owner = setup({ mapping: false, provider: false })
  const phone = browser()
  const endpoint = 'https://push.example/owner-phone'
  assert.equal((await owner.call('push/subscribe', { subscription: { endpoint, keys: phone.keys } })).status, 200)
  const people = setup()
  people.as('stranger')
  assert.equal((await people.call('push/state', { endpoint })).status, 403)
  assert.equal((await people.call('push/unsubscribe', { endpoint })).status, 403)
  assert.equal((await people.call('push/test', { title: 'T', body: 'B' })).status, 403)
  assert.equal((await owner.call('push/state', { endpoint })).body.subscribed, true)
})
