/**
 * The inbox API. Exact Fetch routes under DSH's `/api`, so DSH admits the
 * browser first and a `requestIdentity` provider sees the request; every
 * answer is decided here, per request, from who is asking.
 *
 *   GET  /api/notify-inbox/summary                   counts per group, unread, the summary line, the domain map
 *   GET  /api/notify-inbox/items?view=unread&keep=&before=&limit=
 *   GET  /api/notify-inbox/events                    text/event-stream: a notice whenever the caller's inbox changed
 *   POST /api/notify-inbox/read                      { ids: [...], read?: false } or { all: true }
 *   GET  /api/notify-inbox/file?id=&name=            a stored attachment
 *   GET  /api/notify-inbox/push/config               { publicKey }
 *   POST /api/notify-inbox/push/state                { endpoint } → { subscribed }
 *   POST /api/notify-inbox/push/subscribe            { subscription, label }
 *   POST /api/notify-inbox/push/unsubscribe          { endpoint }
 *   POST /api/notify-inbox/push/test
 *   GET  /api/notify-inbox/strings                   the page's words by language tag (locale/<tag>.json)
 *   GET  /api/notify-inbox/sw.js                     the service worker (scope /api/notify-inbox/)
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { viewerOf } from '@soffits/dsh-plugin-sdk/host'
import { PERSON_PATTERN } from './store.js'
import { buildItems, countItems } from './view.js'

export const PREFIX = '/api/notify-inbox'
const MAX_BODY = 16 * 1024
const PAGE = 50
/** Most items a filtered view keeps on screen after they leave it (keys in `keep`). */
const KEEP_MAX = 200
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/

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
 * @param {ReturnType<import('@soffits/dsh-plugin-sdk/host').createPeople>} options.people
 * @param {ReturnType<import('./push.js').createPush>} options.push
 * @param {() => object | undefined} options.identity - the requestIdentity service right now, if any
 * @param {string} options.serviceWorker - the service worker's source
 * @param {() => Promise<Record<string, Record<string, string>>>} [options.strings] - the page's words, complete per tag, read for each request
 * @param {ReturnType<import('./changes.js').createChanges>} options.changes
 * @param {ReturnType<import('@soffits/dsh-plugin-sdk/host').createEventStreams>} options.streams - the open event streams, ended when the plugin unloads
 * @param {Record<string, { icon: string, tone?: string }>} options.domains - the domain map (src/domains.js)
 * @param {number} options.summaryHours - how long a summary line is shown
 */
export function createRoutes({ store, people, push, identity, serviceWorker, strings = async () => ({}), changes, streams, domains, summaryHours, quiet = [] }) {
  const hushed = new Set(quiet.map(person => String(person).trim().toLowerCase()))
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

  /** The caller's items, folded and grouped as of now. */
  async function itemsOf(who) {
    const { items: records, bad } = await store.view(who.folders)
    return { items: buildItems(records, Date.now()), bad }
  }

  const summary = handle(async (_request, who) => {
    const [{ items, bad }, line] = await Promise.all([itemsOf(who), store.summaryLine(who.folders, summaryHours)])
    const { groups, unread } = countItems(items)
    const latest = items.reduce((newest, item) => (newest === null || item.time > newest ? item.time : newest), null)
    const badge = who.person !== null && who.person !== undefined && hushed.has(who.person.toLowerCase()) ? 'dot' : 'count'
    return json(200, { mode: who.mode, person: who.person, unread, badge, groups, total: items.length, latest, line, domains, problems: { badLines: bad } })
  })

  const list = handle(async (request, who) => {
    const params = new URL(request.url).searchParams
    const limit = Math.min(Math.max(Number(params.get('limit')) || PAGE, 1), 200)
    let { items } = await itemsOf(who)
    if (params.get('view') === 'unread') {
      // `keep` holds what the page already shows in this view, so those items stay put as they leave it.
      const keep = new Set((params.get('keep') ?? '').split(',').filter(key => ITEM_KEY.test(key)).slice(0, KEEP_MAX))
      items = items.filter(item => !item.read || keep.has(item.key))
    }
    const before = params.get('before')
    if (before) {
      const at = items.findIndex(item => item.key === before)
      items = at < 0 ? [] : items.slice(at + 1)
    }
    const page = items.slice(0, limit)
    return json(200, { items: page, more: items.length > limit })
  })

  /** A notice whenever the caller's inbox changed; ends when the page goes. */
  const events = handle(async (request, who) => {
    const mine = who.mode === 'owner' ? undefined : person => who.folders.includes(person)
    return streams.respond(request, ({ send }) => changes.listen(() => send({ type: 'change', at: new Date().toISOString() }), mine))
  })

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

  const ownInbox = fn => handle((request, who) => (who.mode === 'people' && who.person === undefined ? json(403, { error: 'You have no inbox here.' }) : fn(request, who)))

  const pushConfig = handle(async () => json(200, { publicKey: (await push.vapid()).publicKey }))
  const pushState = ownInbox(async (request, who) => {
    const value = await body(request)
    return json(200, { subscribed: typeof value.endpoint === 'string' && (await push.has(who.person, value.endpoint)) })
  })
  const subscribe = ownInbox(async (request, who) => {
    const value = await body(request)
    try {
      await push.subscribe(who.person, value.subscription, value.label)
    } catch (error) {
      return json(400, { error: error.message })
    }
    return json(200, { ok: true })
  })
  const unsubscribe = ownInbox(async (request, who) => {
    const value = await body(request)
    if (typeof value.endpoint !== 'string') return json(400, { error: 'Send the endpoint.' })
    await push.unsubscribe(who.person, value.endpoint)
    return json(200, { ok: true })
  })
  const pushTest = ownInbox(async (request, who) => json(200, await push.test(who.person, await body(request))))

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
