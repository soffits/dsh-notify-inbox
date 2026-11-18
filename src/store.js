/**
 * The inbox store: what the notification router files, and the read marks
 * this plugin keeps beside it.
 *
 *   <dataDir>/<person>/inbox.jsonl      one record per line; written by the router only
 *   <dataDir>/<person>/files/<id>/<name> attachments the router copied in
 *   <dataDir>/<person>/read.json        read marks; written by this plugin only
 *   <dataDir>/<person>/summary.json     the line shown above the items; written by the router's side
 *   <dataDir>/<person>/asks.json        what waits on the person's answer now; written by whatever keeps their
 *                                       list of asks (a Todo), read fresh each time
 *
 * Records are re-read incrementally: only the bytes appended since the last
 * look are parsed, and the whole file again when it shrank or was replaced
 * (someone removed a test entry). A line that isn't a valid record is skipped
 * and counted, never fatal.
 */
import { open, readFile, readdir, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const PERSON_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const INBOX = 'inbox.jsonl'
const READ = 'read.json'
const SUMMARY = 'summary.json'
const ASKS = 'asks.json'

const text = value => (typeof value === 'string' ? value : '')
const list = value => (Array.isArray(value) ? value : [])
/** Text a person reads: a string, or a map from language tag to text (the page picks the language). */
const words = value => (typeof value === 'string' ? value : value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string') ? value : '')

export const GROUPS = ['urgent', 'needs-you', 'live', 'handled', 'info']
const MAX_THREAD = 120
const MAX_ASK_TEXT = 8000

const isoTime = value => {
  const at = Date.parse(text(value))
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

/** `live` as `{ until?, progress?: { from, to } }`, or null. */
function liveOf(raw) {
  if (raw === true) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  const until = isoTime(raw.until)
  if (until !== undefined) out.until = until
  const from = isoTime(raw.progress?.from)
  const to = isoTime(raw.progress?.to)
  if (from !== undefined && to !== undefined && from < to) out.progress = { from, to }
  return out
}

/** `handled` as `{ text, at? }`, or null. */
function handledOf(raw) {
  const value = typeof raw === 'string' ? { text: raw } : raw
  if (value === null || typeof value !== 'object' || Array.isArray(value) || text(value.text).trim() === '') return null
  const at = isoTime(value.at)
  return at === undefined ? { text: value.text.trim() } : { text: value.text.trim(), at }
}

/**
 * The group a record belongs in. A writer usually says (`attention`); for a record that doesn't,
 * the same default the router documents: handled, then live, then urgent for an interrupt, else info.
 * Needs-you is never a default: it is for asks (see `asks`).
 */
export function attentionOf(record) {
  if (GROUPS.includes(record.attention)) return record.attention
  if (record.handled !== null) return 'handled'
  if (record.live !== null) return 'live'
  if (record.lane === 'interrupt') return 'urgent'
  return 'info'
}

const actionsOf = raw => list(raw).filter(action => typeof action?.kind === 'string' && typeof action?.id === 'string').map(action => ({
  kind: action.kind,
  id: action.id,
  label: words(action.label) || undefined,
  payload: typeof action.payload === 'object' && action.payload !== null && !Array.isArray(action.payload) ? action.payload : {},
  ...(typeof action.inverse?.kind === 'string' ? { inverse: { kind: action.inverse.kind, payload: typeof action.inverse.payload === 'object' && action.inverse.payload !== null ? action.inverse.payload : {} } } : {}),
}))

/** One entry of `asks.json` as the page gets it, or undefined when it is not one. */
export function normalizeAsk(raw, person) {
  if (typeof raw !== 'object' || raw === null || !RECORD_ID_PATTERN.test(text(raw.id))) return undefined
  const time = isoTime(raw.time)
  if (time === undefined || text(raw.title).trim() === '') return undefined
  const day = value => (/^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? value : undefined)
  return {
    id: raw.id,
    person,
    time,
    title: text(raw.title),
    text: text(raw.text).slice(0, MAX_ASK_TEXT),
    domain: text(raw.domain),
    next: day(raw.next),
    due: day(raw.due),
    points: Number.isFinite(raw.points) && raw.points > 0 ? Math.round(raw.points) : null,
    session: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text(raw.session)) ? raw.session : null,
    actions: actionsOf(raw.actions),
  }
}

/** A record as the page gets it, or undefined when the line is not one. */
export function normalize(raw, person) {
  if (typeof raw !== 'object' || raw === null || !RECORD_ID_PATTERN.test(text(raw.id))) return undefined
  const time = Date.parse(text(raw.time))
  if (Number.isNaN(time)) return undefined
  const record = {
    id: raw.id,
    person,
    time: new Date(time).toISOString(),
    lane: text(raw.lane) || 'next-moment',
    domain: text(raw.domain),
    title: text(raw.title),
    spoken: text(raw.spoken),
    text: text(raw.text),
    links: list(raw.links).filter(link => typeof link === 'string' && /^https?:\/\//i.test(link)),
    files: list(raw.files).filter(file => typeof file?.name === 'string').map(file => ({
      name: file.name,
      size: typeof file.size === 'number' ? file.size : undefined,
      stored: file.stored === true,
      reason: text(file.reason) || undefined,
    })),
    source: text(raw.source),
    key: text(raw.key),
    actions: actionsOf(raw.actions),
    attention: text(raw.attention),
    thread: text(raw.thread).trim().slice(0, MAX_THREAD),
    live: liveOf(raw.live),
    handled: handledOf(raw.handled),
    session: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text(raw.session)) ? raw.session : null,
    test: raw.test === true,
    push: raw.push !== false,
    routed: list(raw.routed).filter(row => typeof row?.destination === 'string').map(row => ({
      destination: row.destination,
      type: text(row.type),
      ok: row.ok === true,
      detail: text(row.detail) || undefined,
    })),
  }
  record.attention = attentionOf(record)
  if (record.live === null && record.attention === 'live') record.live = {}
  return record
}

/** A "this press was handled" line the router appends after acting on a press, or undefined. */
export function normalizeHandled(raw) {
  if (raw?.type !== 'handled' || typeof raw.record !== 'string') return undefined
  return { record: raw.record, press: text(raw.press), action: text(raw.action), result: text(raw.result), until: text(raw.until) || undefined, time: text(raw.time) }
}

/**
 * Complete lines in `chunk`, parsed; the unfinished tail (a write in progress) is left for next time.
 * Lines with a `type` are status lines, not records.
 */
export function parseLines(chunk, person) {
  const end = chunk.lastIndexOf(0x0a)
  if (end < 0) return { records: [], handled: [], bad: 0, used: 0 }
  const records = []
  const handled = []
  let bad = 0
  for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    if (value?.type !== undefined) {
      const status = normalizeHandled(value)
      if (status !== undefined) handled.push(status)
      continue
    }
    const record = normalize(value, person)
    if (record === undefined) bad += 1
    else records.push(record)
  }
  return { records, handled, bad, used: end + 1 }
}

export async function readFrom(path, offset) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.max(0, size - offset)
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, offset)
    return buffer
  } finally {
    await handle.close()
  }
}

const HEAD_BYTES = 256

/** The first bytes of a file, as text (empty when it can't be read). */
async function readHead(path, length) {
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return buffer.subarray(0, bytesRead).toString('latin1')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

async function atomicWrite(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}

/**
 * Read marks: everything up to `readBefore` (ISO time) is read, plus the ids in
 * `read`, except the ids in `unread` (marked unread again after the watermark
 * passed them).
 */
export function isRead(marks, record) {
  if (marks.unread.includes(record.id)) return false
  return (marks.readBefore !== '' && record.time <= marks.readBefore) || marks.read.includes(record.id)
}

export function createStore(dataDir) {
  const cache = new Map()      // person -> { ino, offset, records, bad }

  async function persons() {
    let entries
    try {
      entries = await readdir(dataDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries.filter(entry => entry.isDirectory() && PERSON_PATTERN.test(entry.name)).map(entry => entry.name).sort()
  }

  /** Every record of one person, oldest first. */
  async function records(person) {
    const path = join(dataDir, person, INBOX)
    let info
    try {
      info = await stat(path)
    } catch {
      cache.delete(person)
      return { records: [], handled: [], bad: 0 }
    }
    let entry = cache.get(person)
    // A file rewritten in place (same inode, someone removed a line by hand) starts differently.
    const replaced = entry !== undefined && entry.head !== '' && (await readHead(path, entry.head.length)) !== entry.head
    if (entry === undefined || entry.ino !== info.ino || info.size < entry.offset || replaced) {
      entry = { ino: info.ino, offset: 0, head: '', records: [], handled: [], bad: 0 }
      cache.set(person, entry)
    }
    if (info.size > entry.offset) {
      if (entry.offset === 0) entry.head = await readHead(path, HEAD_BYTES)
      const parsed = parseLines(await readFrom(path, entry.offset), person)
      entry.records.push(...parsed.records)
      entry.handled.push(...parsed.handled)
      entry.bad += parsed.bad
      entry.offset += parsed.used
    }
    return { records: entry.records, handled: entry.handled, bad: entry.bad }
  }

  /**
   * What waits on this person now, read fresh from `<person>/asks.json`: `{ present, asks }`. Without the
   * file nothing is said about asks and records keep their own groups; with it, it alone says what needs them.
   */
  async function asks(person) {
    let value
    try {
      value = JSON.parse(await readFile(join(dataDir, person, ASKS), 'utf8'))
    } catch {
      return { present: false, asks: [] }
    }
    return { present: true, asks: list(value?.asks).map(raw => normalizeAsk(raw, person)).filter(Boolean) }
  }

  async function marks(person) {
    try {
      const value = JSON.parse(await readFile(join(dataDir, person, READ), 'utf8'))
      const ids = key => list(value[key]).filter(id => typeof id === 'string')
      return { readBefore: text(value.readBefore), read: ids('read'), unread: ids('unread') }
    } catch {
      return { readBefore: '', read: [], unread: [] }
    }
  }

  async function saveMarks(person, value) {
    await mkdir(join(dataDir, person), { recursive: true })
    await atomicWrite(join(dataDir, person, READ), value)
  }

  /**
   * Mark some records read or unread; ids that aren't this person's are ignored.
   * Each list keeps only what the watermark doesn't already say.
   */
  async function setRead(person, ids, value) {
    const byId = new Map([...(await asks(person)).asks, ...(await records(person)).records].map(row => [row.id, row]))
    const current = await marks(person)
    const read = new Set(current.read)
    const unread = new Set(current.unread)
    for (const id of ids) {
      const record = byId.get(id)
      if (record === undefined) continue
      const covered = current.readBefore !== '' && record.time <= current.readBefore
      read.delete(id)
      unread.delete(id)
      if (value && !covered) read.add(id)
      if (!value && covered) unread.add(id)
    }
    await saveMarks(person, { readBefore: current.readBefore, read: [...read], unread: [...unread] })
  }

  /** Mark everything up to the newest record read; the per-id lists drop what the watermark covers. */
  async function markAllRead(person) {
    const all = (await records(person)).records
    if (all.length === 0) return
    const readBefore = all.reduce((latest, record) => (record.time > latest ? record.time : latest), '')
    const current = await marks(person)
    const byId = new Map(all.map(record => [record.id, record]))
    await saveMarks(person, { readBefore, read: current.read.filter(id => byId.has(id) && byId.get(id).time > readBefore), unread: [] })
  }

  /**
   * The records of these people, newest first, each with `read` and the `outcomes` of presses on it, and
   * their asks by person (`{ present, asks }`, each ask with `read`).
   */
  async function view(people) {
    const out = []
    const asking = new Map()
    let bad = 0
    for (const person of people) {
      const [{ records: rows, handled, bad: skipped }, marked, open] = await Promise.all([records(person), marks(person), asks(person)])
      bad += skipped
      const byRecord = new Map()
      for (const status of handled) byRecord.set(status.record, [...(byRecord.get(status.record) ?? []), status])
      for (const record of rows) out.push({ ...record, read: isRead(marked, record), outcomes: byRecord.get(record.id) ?? [] })
      asking.set(person, { present: open.present, asks: open.asks.map(ask => ({ ...ask, read: isRead(marked, ask), outcomes: byRecord.get(ask.id) ?? [] })) })
    }
    out.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
    return { items: out, asks: asking, bad }
  }

  /**
   * The newest summary line of these people (`<person>/summary.json`, `{ text, at }`, written by
   * whatever keeps the inbox), or null when there is none or it is older than `maxHours`.
   */
  async function summaryLine(people, maxHours, now = Date.now()) {
    let best = null
    for (const person of people) {
      let value
      try {
        value = JSON.parse(await readFile(join(dataDir, person, SUMMARY), 'utf8'))
      } catch {
        continue
      }
      const said = words(value?.text)
      const at = isoTime(value?.at)
      if (said === '' || at === undefined || now - Date.parse(at) > maxHours * 3600 * 1000) continue
      if (best === null || at > best.at) best = { text: said, at }
    }
    return best
  }

  /** Where a stored attachment lives, or undefined. */
  async function file(people, id, name) {
    if (!RECORD_ID_PATTERN.test(id) || typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name.startsWith('.')) return undefined
    for (const person of people) {
      const record = (await records(person)).records.find(row => row.id === id)
      const entry = record?.files.find(row => row.name === name && row.stored)
      if (entry !== undefined) return { path: join(dataDir, person, 'files', id, name), name }
    }
    return undefined
  }

  return { persons, records, asks, marks, setRead, markAllRead, view, summaryLine, file }
}
