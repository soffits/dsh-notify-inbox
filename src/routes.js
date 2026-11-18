/**
 * The inbox API. Exact Fetch routes under DSH's `/api`, so DSH admits the
 * browser first and a `requestIdentity` provider sees the request; every
 * answer is decided here, per request, from who is asking.
 *
 *   GET  /api/notify-inbox/summary                   counts per group, unread, the summary line, the domain map
 *   GET  /api/notify-inbox/items?view=needs-you&keep=&before=&limit=
 *   GET  /api/notify-inbox/events                    text/event-stream: a notice whenever the caller's inbox changed
 *   POST /api/notify-inbox/reply                     { record, text }  a reply to an ask, put into the session that asked
 *   POST /api/notify-inbox/read                      { ids: [...], read?: false } or { all: true }
 *   POST /api/notify-inbox/action                    { record, action, until? }  a done/snooze/event press (record: a
 *                                                    record id or an ask's id; an ask's own buttons win in its thread)
 *   GET  /api/notify-inbox/file?id=&name=            a stored attachment
 *   GET  /api/notify-inbox/push/config               { publicKey }
 *   POST /api/notify-inbox/push/state                { endpoint } → { subscribed }
 *   POST /api/notify-inbox/push/subscribe            { subscription, label }
 *   POST /api/notify-inbox/push/unsubscribe          { endpoint }
 *   POST /api/notify-inbox/push/test
 *   GET  /api/notify-inbox/strings                   the page's words by language tag (src/locales.js)
 *   GET  /api/notify-inbox/sw.js                     the service worker (scope /api/notify-inbox/)
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { viewerOf } from './access.js'
import { EMITTING } from './actions.js'
import { PERSON_PATTERN, RECORD_ID_PATTERN } from './store.js'
import { buildItems, countItems } from './view.js'

export const PREFIX = '/api/notify-inbox'
const MAX_BODY = 16 * 1024
const PAGE = 50
/** Most items a filtered view keeps on screen after they leave it (keys in `keep`). */
const KEEP_MAX = 200
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const HEARTBEAT_MS = 25 * 1000

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
}

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } })
const NO_PROVIDER = 'This inbox needs a sign-in plugin that provides requestIdentity, and none is running.'

const FILE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
}

async function body(request) {
  const text = await request.text()
  if (text.length > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 })
  try {
    const value = JSON.parse(text || '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw Object.assign(new Error('Send a JSON object.'), { status: 400 })
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {ReturnType<import('./access.js').createPeople>} options.people
 * @param {ReturnType<import('./push.js').createPush>} options.push
 * @param {ReturnType<import('./actions.js').createActions>} options.actions
 * @param {() => object | undefined} options.identity - the requestIdentity service right now, if any
 * @param {string} options.serviceWorker - the service worker's source
 * @param {() => Promise<Record<string, Record<string, string>>>} [options.strings] - the page's words, complete per tag, read for each request
 * @param {(request: { session: string, words: string, item: object, identity: object | undefined }) => Promise<object>} [options.reply] - puts a reply into a session (src/reply.js)
 * @param {ReturnType<import('./changes.js').createChanges>} options.changes
 * @param {Record<string, { icon: string, tone?: string }>} options.domains - the domain map (src/domains.js)
 * @param {number} options.summaryHours - how long a summary line is shown
 */
export function createRoutes({ store, people, push, actions, identity, serviceWorker, strings = async () => ({}), reply, changes, domains, summaryHours }) {
  /** Who is asking, as the inbox folders they may read; undefined with the response to send instead. */
  async function caller() {
    const viewer = await viewerOf(people, identity())
    if (viewer.unavailable) return { response: json(503, { error: NO_PROVIDER }) }
    if (viewer.mode === 'owner') return { mode: 'owner', person: null, folders: await store.persons() }
    const person = viewer.person !== undefined && PERSON_PATTERN.test(viewer.person) ? viewer.person : undefined
    return { mode: 'people', person, folders: person === undefined ? [] : [person] }
  }

  const handle = fn => async request => {
    try {
      const who = await caller()
      if (who.response !== undefined) return who.response
      return await fn(request, who)
    } catch (error) {
      return json(error.status ?? 500, { error: error.status ? error.message : 'Something went wrong.' })
    }
  }

  async function withPresses(who, items) {
    const byPerson = new Map()
    for (const person of new Set(items.map(item => item.person))) byPerson.set(person, await actions.presses(person))
    return items.map(item => ({ ...item, presses: byPerson.get(item.person)?.get(item.id) ?? [] }))
  }

  /** The caller's items, folded and grouped as of now. */
  async function itemsOf(who) {
    const { items: records, asks, bad } = await store.view(who.folders)
    return { items: buildItems(records, Date.now(), asks), bad }
  }

  const summary = handle(async (_request, who) => {
    const [{ items, bad }, line] = await Promise.all([itemsOf(who), store.summaryLine(who.folders, summaryHours)])
    const { groups, unread } = countItems(items)
    const latest = items.reduce((newest, item) => (newest === null || item.time > newest ? item.time : newest), null)
    return json(200, { mode: who.mode, person: who.person, unread, groups, total: items.length, latest, line, domains, problems: { badLines: bad } })
  })

  const list = handle(async (request, who) => {
    const params = new URL(request.url).searchParams
    const limit = Math.min(Math.max(Number(params.get('limit')) || PAGE, 1), 200)
    let { items } = await itemsOf(who)
    if (params.get('view') === 'needs-you') {
      // `keep` holds what the page already shows in this view, so those items stay put as they leave it.
      const keep = new Set((params.get('keep') ?? '').split(',').filter(key => ITEM_KEY.test(key)).slice(0, KEEP_MAX))
      items = items.filter(item => item.group === 'needs-you' || keep.has(item.key))
    }
    const before = params.get('before')
    if (before) {
      const at = items.findIndex(item => item.key === before)
      items = at < 0 ? [] : items.slice(at + 1)
    }
    const page = items.slice(0, limit)
    return json(200, { items: await withPresses(who, page), more: items.length > limit })
  })

  /** A notice per change, a comment every 25 s so proxies keep the stream open; ends when the page goes. */
  const events = handle(async (request, who) => {
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream({
      start(controller) {
        const write = chunk => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            stop()
          }
        }
        write('retry: 5000\n: open\n\n')
        const unlisten = changes.listen(who.mode === 'owner' ? null : who.folders, () => write(`data: ${JSON.stringify({ type: 'change', at: new Date().toISOString() })}\n\n`))
        const beat = setInterval(() => write(': beat\n\n'), HEARTBEAT_MS)
        stop = () => {
          unlisten()
          clearInterval(beat)
        }
        request.signal?.addEventListener('abort', () => {
          stop()
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }, { once: true })
      },
      cancel() {
        stop()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-cache, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' },
    })
  })

  /**
   * The record (or open ask) with this id the caller may see, with the buttons it answers to: an open
   * ask's own for the ask and every record in its thread. Undefined when there is none.
   */
  async function recordOf(who, id) {
    if (typeof id !== 'string' || !RECORD_ID_PATTERN.test(id)) return undefined
    for (const person of who.folders) {
      const { asks } = await store.asks(person)
      const record = (await store.records(person)).records.find(row => row.id === id)
      const ask = asks.find(row => row.id === id || row.id === record?.thread)
      if (record !== undefined) return ask === undefined ? record : { ...record, session: ask.session ?? record.session, actions: [...record.actions.filter(a => a.kind !== 'done' && a.kind !== 'snooze'), ...ask.actions] }
      if (ask !== undefined) return { ...ask, key: '', thread: ask.id }
    }
    return undefined
  }

  const read = handle(async (request, who) => {
    const value = await body(request)
    if (value.all === true) {
      for (const person of who.folders) await store.markAllRead(person)
    } else if (Array.isArray(value.ids)) {
      const ids = value.ids.filter(id => typeof id === 'string').slice(0, 500)
      for (const person of who.folders) await store.setRead(person, ids, value.read !== false)
    } else {
      return json(400, { error: 'Send ids or all.' })
    }
    return json(200, { ok: true })
  })

  const action = handle(async (request, who) => {
    const value = await body(request)
    const record = await recordOf(who, value.record)
    if (record === undefined) return json(404, { error: 'No such notification.' })
    const declared = record.actions.find(row => row.id === value.action)
    if (declared === undefined) return json(400, { error: 'This notification has no such button.' })
    if (!EMITTING.includes(declared.kind)) return json(400, { error: 'This button acts in the page.' })
    const result = await actions.press(record.person, record, declared, { until: value.until })
    await store.setRead(record.person, [record.id], true)
    return json(200, { press: result.event.press, published: result.published, matched: result.matched ?? 0 })
  })

  /** A reply to an ask the caller sees, into the session the ask names (its own, else its notification's). */
  const answer = handle(async (request, who) => {
    const value = await body(request)
    const record = await recordOf(who, value.record)
    if (record === undefined) return json(404, { error: 'No such notification.' })
    const session = record.session
    if (typeof session !== 'string' || session === '') return json(400, { error: 'This notification names no conversation to reply to.' })
    if (reply === undefined) return json(503, { error: 'Replies need a DSH that lets plugins reach its sessions.' })
    const askId = (await store.asks(record.person)).asks.find(ask => ask.id === record.thread || ask.id === record.id)?.id
    try {
      const sent = await reply({ session, words: value.text, item: { id: record.id, title: record.title, text: record.text, thread: record.thread, ask: askId }, identity: identity()?.current?.() ?? undefined })
      await store.setRead(record.person, [record.id], true)
      return json(200, { ok: true, session: sent.session, woke: sent.woke })
    } catch (error) {
      return json(error.status ?? 502, { error: error.message })
    }
  })

  const file = handle(async (request, who) => {
    const params = new URL(request.url).searchParams
    const found = await store.file(who.folders, params.get('id') ?? '', params.get('name') ?? '')
    if (found === undefined) return json(404, { error: 'No such file.' })
    const type = FILE_TYPES[extname(found.name).toLowerCase()] ?? 'application/octet-stream'
    const inline = type !== 'application/octet-stream' && !type.startsWith('text/html')
    return new Response(await readFile(found.path), {
      status: 200,
      headers: {
        'content-type': type,
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    })
  })

  const pushConfig = handle(async () => json(200, { publicKey: (await push.vapid()).publicKey }))
  const pushState = handle(async (request, who) => {
    const value = await body(request)
    return json(200, { subscribed: typeof value.endpoint === 'string' && (await push.has(who.person, value.endpoint)) })
  })
  const subscribe = handle(async (request, who) => {
    if (who.mode === 'people' && who.person === undefined) return json(403, { error: 'You have no inbox here.' })
    const value = await body(request)
    try {
      await push.subscribe(who.person, value.subscription, value.label)
    } catch (error) {
      return json(400, { error: error.message })
    }
    return json(200, { ok: true })
  })
  const unsubscribe = handle(async (request, who) => {
    const value = await body(request)
    if (typeof value.endpoint !== 'string') return json(400, { error: 'Send the endpoint.' })
    await push.unsubscribe(who.person, value.endpoint)
    return json(200, { ok: true })
  })
  const pushTest = handle(async (request, who) => json(200, await push.test(who.person, await body(request))))

  // Read for each request and never cached: an update in place brings new words with no stale copy anywhere.
  const words = async () => json(200, { tables: await strings() }, { 'cache-control': 'no-store' })

  const worker = async () => new Response(serviceWorker, {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
  })

  const get = (path, fetch) => ({ path: `${PREFIX}${path}`, methods: ['GET'], requestBody: 'buffered', fetch })
  const post = (path, fetch) => ({ path: `${PREFIX}${path}`, methods: ['POST'], requestBody: 'buffered', fetch })
  return [
    get('/summary', summary),
    get('/items', list),
    get('/events', events),
    post('/read', read),
    post('/action', action),
    post('/reply', answer),
    get('/file', file),
    get('/push/config', pushConfig),
    post('/push/state', pushState),
    post('/push/subscribe', subscribe),
    post('/push/unsubscribe', unsubscribe),
    post('/push/test', pushTest),
    get('/strings', words),
    get('/sw.js', worker),
  ]
}
