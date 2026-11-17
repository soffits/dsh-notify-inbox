/**
 * The inbox store: what the notification router files, and the read marks
 * this plugin keeps beside it.
 *
 *   <dataDir>/<person>/inbox.jsonl      one record per line; written by the router only
 *   <dataDir>/<person>/files/<id>/<name> attachments the router copied in
 *   <dataDir>/<person>/read.json        read marks; written by this plugin only
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

const text = value => (typeof value === 'string' ? value : '')
const list = value => (Array.isArray(value) ? value : [])

/** A record as the page gets it, or undefined when the line is not one. */
export function normalize(raw, person) {
  if (typeof raw !== 'object' || raw === null || !RECORD_ID_PATTERN.test(text(raw.id))) return undefined
  const time = Date.parse(text(raw.time))
  if (Number.isNaN(time)) return undefined
  return {
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
    actions: list(raw.actions).filter(action => typeof action?.kind === 'string' && typeof action?.id === 'string').map(action => ({
      kind: action.kind,
      id: action.id,
      label: text(action.label),
      payload: typeof action.payload === 'object' && action.payload !== null && !Array.isArray(action.payload) ? action.payload : {},
    })),
    test: raw.test === true,
    push: raw.push !== false,
    routed: list(raw.routed).filter(row => typeof row?.destination === 'string').map(row => ({
      destination: row.destination,
      type: text(row.type),
      ok: row.ok === true,
      detail: text(row.detail) || undefined,
    })),
  }
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

async function atomicWrite(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, path)
}

/** Read marks: everything up to `readBefore` (ISO time) is read, plus the ids in `read`. */
export function isRead(marks, record) {
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
    if (entry === undefined || entry.ino !== info.ino || info.size < entry.offset) {
      entry = { ino: info.ino, offset: 0, records: [], handled: [], bad: 0 }
      cache.set(person, entry)
    }
    if (info.size > entry.offset) {
      const parsed = parseLines(await readFrom(path, entry.offset), person)
      entry.records.push(...parsed.records)
      entry.handled.push(...parsed.handled)
      entry.bad += parsed.bad
      entry.offset += parsed.used
    }
    return { records: entry.records, handled: entry.handled, bad: entry.bad }
  }

  async function marks(person) {
    try {
      const value = JSON.parse(await readFile(join(dataDir, person, READ), 'utf8'))
      return { readBefore: text(value.readBefore), read: list(value.read).filter(id => typeof id === 'string') }
    } catch {
      return { readBefore: '', read: [] }
    }
  }

  async function saveMarks(person, value) {
    await mkdir(join(dataDir, person), { recursive: true })
    await atomicWrite(join(dataDir, person, READ), value)
  }

  /** Mark some records read; ids that aren't this person's are ignored. */
  async function markRead(person, ids) {
    const known = new Set((await records(person)).records.map(record => record.id))
    const current = await marks(person)
    const read = [...new Set([...current.read, ...ids.filter(id => known.has(id))])]
    await saveMarks(person, { readBefore: current.readBefore, read })
  }

  /** Mark everything up to the newest record read; the per-id list drops what the watermark covers. */
  async function markAllRead(person) {
    const all = (await records(person)).records
    if (all.length === 0) return
    const readBefore = all.reduce((latest, record) => (record.time > latest ? record.time : latest), '')
    const current = await marks(person)
    const byId = new Map(all.map(record => [record.id, record]))
    await saveMarks(person, { readBefore, read: current.read.filter(id => byId.has(id) && byId.get(id).time > readBefore) })
  }

  /** The records of these people, newest first, each with `read`. */
  async function view(people) {
    const out = []
    let bad = 0
    for (const person of people) {
      const [{ records: rows, handled, bad: skipped }, marked] = await Promise.all([records(person), marks(person)])
      bad += skipped
      const byRecord = new Map()
      for (const status of handled) byRecord.set(status.record, [...(byRecord.get(status.record) ?? []), status])
      for (const record of rows) out.push({ ...record, read: isRead(marked, record), handled: byRecord.get(record.id) ?? [] })
    }
    out.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
    return { items: out, bad }
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

  return { persons, records, marks, markRead, markAllRead, view, file }
}
