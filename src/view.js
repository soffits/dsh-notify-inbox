/**
 * What the page lists: items, not records. Records of one person with the same
 * `thread` fold into one item, the newest on top and the older ones as its
 * history; a live thread's newest record simply replaces the item. Each item
 * gets the group it shows in now, which can differ from what its writer said:
 * an urgent item the person marked done is handled, a snoozed one waits under
 * info until it comes back as a new record, and a live item whose time is over
 * is info.
 *
 * A person whose inbox has an asks file (`asks.json`) gets their "Needs you"
 * from it alone: each open ask is one item, with the records of its thread
 * folded in when there are any, and a record that said needs-you but whose
 * ask is no longer open has been dealt with in its source, so it is handled.
 */
import { createHash } from 'node:crypto'
import { GROUPS } from './store.js'

/** A live item without `until` stops being live this long after its last update. */
export const LIVE_IDLE_MS = 6 * 60 * 60 * 1000
const HISTORY_MAX = 20

/** A stable key for an item: the record id, or a hash of person and thread (safe in a query string). */
export function itemKey(record) {
  if (record.thread === '') return record.id
  return `t-${createHash('sha256').update(`${record.person}\n${record.thread}`).digest('hex').slice(0, 20)}`
}

/** Whether a record's live state still runs at `now` (ms). */
export function liveNow(record, now) {
  if (record.live === null) return false
  const end = record.live.until !== undefined ? Date.parse(record.live.until) : Date.parse(record.time) + LIVE_IDLE_MS
  return now < end
}

/**
 * The group an item's newest record shows in at `now`, with `moved` saying why when it isn't the
 * writer's: 'done' (the person marked it done), 'snoozed', 'ended' (a live item past its time) or
 * 'closed' (its ask is no longer open). `asked` is the person's asks (`{ present, open: Set }`).
 */
export function groupOf(record, now, asked = { present: false, open: new Set() }) {
  if (record.attention === 'needs-you' && asked.present) {
    if (asked.open.has(record.thread)) return { group: 'needs-you', moved: null }
    return record.thread === '' ? { group: record.lane === 'interrupt' ? 'urgent' : 'info', moved: null } : { group: 'handled', moved: 'closed' }
  }
  if (record.attention === 'urgent' || record.attention === 'needs-you') {
    const last = record.outcomes.findLast(row => row.result === 'done' || row.result === 'snoozed')
    if (last?.result === 'done') return { group: 'handled', moved: 'done' }
    if (last?.result === 'snoozed' && (last.until === undefined || Date.parse(last.until) > now)) return { group: 'info', moved: 'snoozed' }
  }
  if (record.attention === 'live' && !liveNow(record, now)) return { group: 'info', moved: 'ended' }
  return { group: record.attention, moved: null }
}

/** An open ask as an item: alone, or on top of its thread's newest record. */
function askItem(ask, record) {
  const base = record ?? {
    id: ask.id, person: ask.person, time: ask.time, lane: 'next-moment', domain: ask.domain, title: ask.title, spoken: '',
    text: ask.text, links: [], files: [], source: '', key: '', actions: [], thread: ask.id, live: null, handled: null,
    session: null, test: false, push: false, routed: [], read: ask.read, outcomes: ask.outcomes,
  }
  return {
    ...base,
    title: ask.title,
    text: record === undefined || record.text === '' ? ask.text : record.text,
    actions: [...base.actions.filter(action => action.kind !== 'done' && action.kind !== 'snooze'), ...ask.actions],
    attention: 'needs-you',
    // The ask says who asked; a notification about it may name a session the ask has since dropped.
    session: ask.session,
    ask: { id: ask.id, points: ask.points, next: ask.next, due: ask.due, text: ask.text, since: ask.since, replied: ask.replied, how: ask.how },
    read: record === undefined ? ask.read : base.read,
  }
}

/**
 * Fold records (newest first, each with `read` and `outcomes`) and the people's asks (person →
 * `{ present, asks }`) into items, newest first by the time of each item's latest notification,
 * whatever group it shows in.
 */
export function buildItems(records, now, asking = new Map()) {
  const asked = new Map([...asking].map(([person, value]) => [person, { present: value.present, open: new Map(value.asks.map(ask => [ask.id, ask])) }]))
  const byKey = new Map()
  for (const record of records) {
    const key = itemKey(record)
    const item = byKey.get(key)
    if (item === undefined) {
      byKey.set(key, { ...record, key, ids: [record.id], history: [] })
      continue
    }
    item.ids.push(record.id)
    item.read &&= record.read
    if (item.history.length < HISTORY_MAX) item.history.push({ id: record.id, time: record.time, title: record.title, spoken: record.spoken })
  }
  for (const [person, { open }] of asked) {
    for (const ask of open.values()) {
      const key = itemKey({ person, thread: ask.id, id: ask.id })
      const folded = byKey.get(key)
      byKey.set(key, folded === undefined ? { ...askItem(ask), key, ids: [ask.id], history: [] } : { ...askItem(ask, folded), key, ids: folded.ids, history: folded.history })
    }
  }
  const items = [...byKey.values()].map(item => {
    const mine = asked.get(item.person)
    const where = groupOf(item, now, mine === undefined ? undefined : { present: mine.present, open: mine.open })
    return { ...item, ...where, liveNow: liveNow(item, now) }
  })
  return items.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
}

/** Items in group order (urgent, needs-you, live, handled, info), keeping their order within a group. */
export function inGroupOrder(items) {
  const rank = group => GROUPS.indexOf(group)
  return [...items].sort((a, b) => rank(a.group) - rank(b.group))
}

/** How many items each group has, and how many are unread. */
export function countItems(items) {
  const groups = Object.fromEntries(GROUPS.map(group => [group, 0]))
  let unread = 0
  for (const item of items) {
    groups[item.group] += 1
    if (!item.read) unread += 1
  }
  return { groups, unread }
}
