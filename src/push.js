/**
 * Web Push to each person's subscribed browsers.
 *
 *   <dataDir>/.push/subscriptions.json   [{ endpoint, keys, person, label, createdAt }]
 *   <dataDir>/.push/cursor.json          { <person>: { ino, offset } }: how far each inbox was pushed
 *   vapidFile (config)                   { publicKey, privateKey }, made on first start, mode 600
 *
 * A subscription belongs to the person who made it (`person`), or to the
 * owner of a single-owner DSH (`person: null`), who gets every person's
 * records. A fresh install starts its cursor at the end of each inbox, so it
 * never pushes old records; after a restart it pushes what arrived meanwhile.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import { parseLines, readFrom } from './store.js'
import { generateVapidKeys, loadVapidKeys, sendPush } from './webpush.js'

const MAX_ENDPOINT = 2048
const MAX_SUBSCRIPTIONS = 50
const BODY_LIMIT = 280

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode })
  await rename(tmp, path)
}

/** The stored VAPID keys, made on first use. The private key never leaves this function's result. */
export async function vapidKeys(path) {
  let stored = await readJson(path, undefined)
  if (stored === undefined) {
    stored = generateVapidKeys()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(stored), { mode: 0o600, flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST') throw error
      stored = JSON.parse(await readFile(path, 'utf8'))
    })
  }
  await chmod(path, 0o600)
  return loadVapidKeys(stored)
}

function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (kind === 6) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  return false
}

/** A browser's subscription as sent by the page, checked, or an Error saying why not. */
export function checkSubscription(value) {
  const endpoint = value?.endpoint
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return new Error('No endpoint.')
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return new Error('The endpoint is not a URL.')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || privateHost(url.hostname)) {
    return new Error('The endpoint must be a public HTTPS address.')
  }
  const p256dh = value?.keys?.p256dh
  const auth = value?.keys?.auth
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return new Error('Missing keys.')
  return { endpoint: url.href, keys: { p256dh, auth } }
}

/** The notification a record becomes: what the push service carries (encrypted) and the service worker shows. */
export function payloadOf(record) {
  const title = record.title || record.spoken.slice(0, 60) || record.text.slice(0, 60) || record.domain
  const body = record.spoken && record.spoken !== record.title ? record.spoken : record.text
  return {
    title: record.test ? `[test] ${title}` : title,
    body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body,
    tag: record.id,
    url: `./?notify-inbox=${encodeURIComponent(record.id)}`,
    urgent: record.lane === 'interrupt',
  }
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.vapidFile
 * @param {string} options.subject - mailto: or https: contact for push services
 * @param {() => boolean} options.perPerson - whether a person mapping is configured right now
 * @param {(message: string) => void} options.warn
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createPush({ dataDir, vapidFile, subject, perPerson, warn, fetchImpl = fetch }) {
  const subsPath = join(dataDir, '.push', 'subscriptions.json')
  const cursorPath = join(dataDir, '.push', 'cursor.json')
  let keys
  let chain = Promise.resolve()
  const serial = task => (chain = chain.then(task, task))

  async function vapid() {
    keys ??= await vapidKeys(vapidFile)
    return keys
  }

  const subscriptions = async () => (await readJson(subsPath, [])).filter(sub => typeof sub?.endpoint === 'string')

  /** Whether a subscription gets a person's records. */
  function reaches(sub, person) {
    if (sub.person === null || sub.person === undefined) return !perPerson()
    return sub.person === person
  }

  function subscribe(person, value, label) {
    return serial(async () => {
      const checked = checkSubscription(value)
      if (checked instanceof Error) throw checked
      const all = (await subscriptions()).filter(sub => sub.endpoint !== checked.endpoint)
      if (all.length >= MAX_SUBSCRIPTIONS) throw new Error('Too many devices are subscribed; turn one off first.')
      all.push({ ...checked, person: person ?? null, label: String(label ?? '').slice(0, 80), createdAt: new Date().toISOString() })
      await writeJson(subsPath, all)
    })
  }

  function unsubscribe(person, endpoint) {
    return serial(async () => {
      const all = await subscriptions()
      const kept = all.filter(sub => !(sub.endpoint === endpoint && (sub.person ?? null) === (person ?? null)))
      if (kept.length !== all.length) await writeJson(subsPath, kept)
    })
  }

  /** Whether this browser (by endpoint) is subscribed for this person. */
  async function has(person, endpoint) {
    return (await subscriptions()).some(sub => sub.endpoint === endpoint && (sub.person ?? null) === (person ?? null))
  }

  async function deliver(subs, payload, urgent) {
    const gone = []
    let sent = 0
    for (const sub of subs) {
      try {
        const result = await sendPush(sub, payload, { vapid: await vapid(), subject, urgency: urgent ? 'high' : 'normal', fetchImpl })
        if (result.ok) sent += 1
        else if (result.gone) gone.push(sub.endpoint)
        else warn(`push to ${new URL(sub.endpoint).host} answered ${result.status}`)
      } catch (error) {
        warn(`push to ${new URL(sub.endpoint).host} failed: ${error.message}`)
      }
    }
    if (gone.length > 0) {
      const all = await subscriptions()
      await writeJson(subsPath, all.filter(sub => !gone.includes(sub.endpoint)))
    }
    return { sent, removed: gone.length }
  }

  /** Push a test, in the words the asking page sends, to the asking person's devices. */
  function test(person, { title, body }) {
    return serial(async () => {
      const subs = (await subscriptions()).filter(sub => (sub.person ?? null) === (person ?? null))
      return deliver(subs, { title: String(title ?? '').slice(0, 80), body: String(body ?? '').slice(0, BODY_LIMIT), tag: 'notify-inbox-test', url: './?notify-inbox=', urgent: false }, false)
    })
  }

  /** Push what was appended to each person's inbox since the last scan. */
  function scan(people) {
    return serial(async () => {
      const cursor = await readJson(cursorPath, {})
      let changed = false
      for (const person of people) {
        const path = join(dataDir, person, 'inbox.jsonl')
        let info
        try {
          info = await stat(path)
        } catch {
          continue
        }
        const seen = cursor[person]
        if (seen === undefined || seen.ino !== info.ino || info.size < seen.offset) {
          cursor[person] = { ino: info.ino, offset: info.size }
          changed = true
          continue
        }
        if (info.size === seen.offset) continue
        const parsed = parseLines(await readFrom(path, seen.offset), person)
        cursor[person] = { ino: info.ino, offset: seen.offset + parsed.used }
        changed = true
        const fresh = parsed.records.filter(record => record.push)
        if (fresh.length === 0) continue
        const subs = (await subscriptions()).filter(sub => reaches(sub, person))
        for (const record of fresh) await deliver(subs, payloadOf(record), record.lane === 'interrupt')
      }
      if (changed) await writeJson(cursorPath, cursor)
    })
  }

  return { vapid, subscribe, unsubscribe, has, test, scan }
}
