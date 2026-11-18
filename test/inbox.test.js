import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { createPeople } from '../src/access.js'
import { createActions } from '../src/actions.js'
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

function setup({ mapping = true, provider = true, events, reply, quiet = [] } = {}) {
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
  const changes = createChanges({ dataDir: dir, persons: () => store.persons() })
  const routes = createRoutes({ store, people, push, actions, changes, reply, strings: async () => ({ en: { title: 'Inbox' } }), identity: () => (provider ? identity : undefined), serviceWorker: '/* sw */', domains: domainMap({ legal: { icon: 'scale', tone: 'violet' } }), summaryHours: 12, quiet })
  const byPath = new Map(routes.map(route => [route.path, route.fetch]))
  const call = async (path, body) => {
    const [bare] = path.split('?')
    const handler = byPath.get(`/api/notify-inbox/${bare}`)
    const request = new Request(`https://dsh.example/api/notify-inbox/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
    const response = await handler(request)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.text(), headers: response.headers }
  }
  return { as, call, store, push, pushes, emitted, changes, byPath }
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

const ASK_DONE = { kind: 'done', id: 'done', payload: { source: 'todo', uuid: 'u1' }, inverse: { kind: 'reopen', payload: {} } }
const ask = (id, extra = {}) => ({ id, title: `Ask ${id}`, text: `Which one, ${id}?`, time: '2026-11-17T14:00:00Z', points: 3, session: 'session-abc', domain: 'todo', actions: [ASK_DONE], ...extra })
const asks = async (person, ...rows) => {
  await mkdir(join(dir, person), { recursive: true })
  await writeFile(join(dir, person, 'asks.json'), JSON.stringify({ v: 1, person, asks: rows }))
}

test('the asks file decides Needs you: open asks show with or without a record, a closed one is handled', async () => {
  await file('ana',
    record('a1', { thread: 'todo:1', attention: 'needs-you', actions: [], session: 'session-old' }),
    record('a2', { thread: 'todo:2', attention: 'needs-you', time: '2026-11-17T16:00:00Z' }),
    record('a3', { time: '2026-11-17T17:00:00Z', actions: [] }),
    record('a4', { lane: 'interrupt', attention: 'needs-you', actions: [], time: '2026-11-17T13:00:00Z' }))
  await asks('ana', ask('todo:1'), ask('todo:3', { title: 'Only in the list', points: 5, next: '2026-11-18' }))
  const { as, call } = setup()
  as(ANA_SUB)
  const items = (await call('items')).body.items
  assert.deepEqual(items.map(item => [item.id, item.group, item.moved]),
    [['a4', 'urgent', null], ['a1', 'needs-you', null], ['todo:3', 'needs-you', null], ['a2', 'handled', 'closed'], ['a3', 'info', null]])
  const one = items.find(item => item.id === 'a1')
  assert.deepEqual([one.title, one.session, one.ask.points, one.actions.map(a => a.kind)], ['Ask todo:1', 'session-abc', 3, ['done']])
  const only = items.find(item => item.id === 'todo:3')
  assert.deepEqual([only.text, only.ask.points, only.ask.next, only.read], ['Which one, todo:3?', 5, '2026-11-18', false])
  assert.equal((await call('summary')).body.groups['needs-you'], 2)
  await call('read', { ids: ['todo:3'] })
  assert.equal((await call('items')).body.items.find(item => item.id === 'todo:3').read, true)
})

test("a press on an ask goes out with the ask's own buttons, for the ask and every record in its thread", async () => {
  await file('ana', record('a1', { thread: 'todo:1', attention: 'needs-you' }))
  await asks('ana', ask('todo:1'), ask('todo:9'))
  const { as, call, emitted } = setup()
  as(ANA_SUB)
  assert.equal((await call('action', { record: 'todo:9', action: 'done' })).status, 200)
  assert.equal((await call('action', { record: 'a1', action: 'done' })).status, 200)
  assert.deepEqual(emitted.map(e => [e.data.source.record, e.data.payload]), [['todo:9', { source: 'todo', uuid: 'u1' }], ['a1', { source: 'todo', uuid: 'u1' }]])
  assert.equal((await call('action', { record: 'a1', action: 'snooze' })).status, 400, "the ask's buttons replace the record's")
  as(BO_SUB)
  assert.equal((await call('action', { record: 'todo:9', action: 'done' })).status, 404)
})

test('under Needs you, items the page already shows stay as their asks close', async () => {
  await file('ana', record('a1', { thread: 'todo:1', attention: 'needs-you' }), record('a2', { thread: 'todo:2', attention: 'needs-you', time: '2026-11-17T16:00:00Z' }), record('a3', { time: '2026-11-17T17:00:00Z', actions: [] }))
  await asks('ana', ask('todo:1'), ask('todo:2'))
  const { as, call } = setup()
  as(ANA_SUB)
  const shown = (await call('items?view=needs-you')).body.items.map(item => item.key)
  await asks('ana', ask('todo:1'))
  const kept = (await call(`items?view=needs-you&keep=${shown.join(',')},nope/../x`)).body.items
  assert.deepEqual(kept.map(item => [item.id, item.group]), [['a1', 'needs-you'], ['a2', 'handled']])
  assert.deepEqual((await call('items?view=needs-you')).body.items.map(item => item.id), ['a1'])
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

test('a step press is recorded as the person\'s go-ahead, per step button', async () => {
  await file('ana', record('a1', { actions: [
    { kind: 'step', id: 'pay', label: { en: 'Pay the invoice', zh: '付这张发票' }, payload: {} },
    { kind: 'step', id: 'file', label: 'File it under taxes', payload: {} },
  ] }))
  const { as, call, emitted } = setup()
  as(ANA_SUB)
  assert.equal((await call('action', { record: 'a1', action: 'file' })).status, 200)
  assert.equal(emitted[0].channel, 'ui.action.step')
  assert.equal(emitted[0].data.person, 'ana')
  assert.equal(emitted[0].data.id, 'file')
  const [item] = (await call('items')).body.items
  assert.deepEqual(item.presses.map(press => [press.action, press.id]), [['step', 'file']])
  assert.deepEqual(item.actions[0].label, { en: 'Pay the invoice', zh: '付这张发票' })
})

test('a done press becomes an action event, is logged, and shows handled once the router says so', async () => {
  await file('ana', record('a1', { lane: 'interrupt' }))
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
  assert.deepEqual(item.outcomes, [])
  assert.equal(item.group, 'urgent')
  await file('ana', { v: 1, type: 'handled', record: 'a1', press: event.data.press, action: 'done', result: 'done', time: '2026-11-17T15:01:00Z' })
  ;[item] = (await call('items')).body.items
  assert.equal(item.outcomes[0].result, 'done')
  assert.deepEqual([item.group, item.moved], ['handled', 'done'])
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
  assert.deepEqual(items.map(item => [item.id, item.group]), [['n1', 'urgent'], ['l1', 'live'], ['h1', 'handled'], ['i1', 'info'], ['l2', 'info'], ['e1', 'info']])
  assert.deepEqual([by.l1.liveNow, by.l2.liveNow, by.l2.moved], [true, false, 'ended'])
  assert.deepEqual(by.h1.handled, { text: 'Asked again; follow-up set.' })
  assert.deepEqual(by.l1.live.progress, { from: past, to: soon })
  const summary = (await call('summary')).body
  assert.deepEqual(summary.groups, { urgent: 1, 'needs-you': 0, live: 1, handled: 1, info: 3 })
  assert.equal(summary.line.text, 'Two things need you.')
  assert.deepEqual([summary.domains.legal, summary.domains.travel], [{ icon: 'scale', tone: 'violet' }, { icon: 'plane' }])
  await writeFile(join(dir, 'ana', 'summary.json'), JSON.stringify({ text: 'Old news.', at: '2026-01-01T00:00:00Z' }))
  assert.equal((await call('summary')).body.line, null, 'an old summary line is not shown')
})

test('a snoozed item waits under info until it comes back', async () => {
  await file('ana', record('a1', { lane: 'interrupt' }))
  const { as, call } = setup()
  as(ANA_SUB)
  const pressed = await call('action', { record: 'a1', action: 'snooze', until: new Date(Date.now() + 3600e3).toISOString() })
  await file('ana', { v: 1, type: 'handled', record: 'a1', press: pressed.body.press, action: 'snooze', result: 'snoozed', until: new Date(Date.now() + 3600e3).toISOString(), time: new Date().toISOString() })
  const [item] = (await call('items')).body.items
  assert.deepEqual([item.group, item.moved], ['info', 'snoozed'])
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
    await asks('ana', ask('todo:1'))
    assert.ok(await until(/"type":"change"/), 'a new asks file is news too')
  } finally {
    abort.abort()
    changes.stop()
  }
})

test('a reply goes to the session the ask names, as the verified person, and only for your own items', async () => {
  await file('ana', record('a1', { thread: 'todo:1', attention: 'needs-you', session: 'session-old' }), record('a2'),
    record('a3', { thread: 'todo:2', attention: 'needs-you', session: 'session-old' }), record('a4', { session: 'session-x' }))
  await asks('ana', ask('todo:1'), ask('todo:2', { session: null }))
  const sent = []
  const { as, call } = setup({ reply: async request => { sent.push(request); return { session: request.session ?? 'session-new', woke: true, fresh: request.session === undefined } } })
  as(ANA_SUB)
  const ok = await call('reply', { record: 'a1', text: 'The white one' })
  assert.deepEqual([ok.status, ok.body.session, ok.body.fresh], [200, 'session-abc', false])
  assert.equal(sent[0].words, 'The white one')
  assert.deepEqual(sent[0].item, { id: 'a1', title: 'Ask todo:1', text: 'Text a1\n\nWhich one, todo:1?', thread: 'todo:1', ask: 'todo:1' })
  assert.deepEqual(sent[0].identity, { provider: 'oidc', issuer: 'https://id.example', id: ANA_SUB })
  const fresh = await call('reply', { record: 'todo:2', text: 'x' })
  assert.deepEqual([fresh.status, fresh.body.session, fresh.body.fresh], [200, 'session-new', true], 'an ask without a session opens a new one')
  assert.equal(sent[1].session, undefined)
  assert.deepEqual(sent[1].item, { id: 'todo:2', title: 'Ask todo:2', text: 'Which one, todo:2?', thread: 'todo:2', ask: 'todo:2' })
  await call('reply', { record: 'a3', text: 'x' })
  assert.equal(sent[2].session, undefined, 'the ask says who asked, not an older notification about it')
  assert.equal((await call('reply', { record: 'a4', text: 'x' })).status, 200, 'a plain notification that names a session')
  assert.equal(sent[3].session, 'session-x')
  assert.equal((await call('reply', { record: 'a2', text: 'x' })).status, 400, 'neither an ask nor a session')
  as(BO_SUB)
  assert.equal((await call('reply', { record: 'a1', text: 'x' })).status, 404)
  assert.equal(sent.length, 4)
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
