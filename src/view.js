/**
 * What the page lists: items, not records. Records of one person with the same
 * `thread` fold into one item, the newest on top and the older ones as its
 * history; a live thread's newest record simply replaces the item. Each item
 * gets the group it shows in now, which can differ from what its writer said:
 * a needs-you item the person marked done is handled, a snoozed one waits
 * under info until it comes back as a new record, and a live item whose time
 * is over is info.
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
 * writer's: 'done' (the person marked it done), 'snoozed', or 'ended' (a live item past its time).
 */
export function groupOf(record, now) {
  if (record.attention === 'needs-you') {
    const last = record.outcomes.findLast(row => row.result === 'done' || row.result === 'snoozed')
    if (last?.result === 'done') return { group: 'handled', moved: 'done' }
    if (last?.result === 'snoozed' && (last.until === undefined || Date.parse(last.until) > now)) return { group: 'info', moved: 'snoozed' }
  }
  if (record.attention === 'live' && !liveNow(record, now)) return { group: 'info', moved: 'ended' }
  return { group: record.attention, moved: null }
}

/**
 * Fold records (newest first, each with `read` and `outcomes`) into items, ordered by group
 * (needs-you, live, handled, info) and newest first within a group.
 */
export function buildItems(records, now) {
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
  const items = [...byKey.values()].map(item => ({ ...item, ...groupOf(item, now), liveNow: liveNow(item, now) }))
  const rank = group => GROUPS.indexOf(group)
  return items.sort((a, b) => rank(a.group) - rank(b.group) || (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
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
