/**
 * What the person has said to an item, as the page shows it: the answer they gave (a choice, a plain done, a
 * snooze or a typed reply) and how far it has got. The sources decide, never this file: a button's answer is
 * applied when the ask closes (it leaves the asks file), a reply has arrived when the ask's owner logged it
 * (`replied` in the asks file) and is settled when the ask closes. The presses log only says what the person
 * did and when; a press older than the ask's last coming back to them (`since`) is about an earlier showing.
 *
 * The times say when the page should stop waiting: `applyBy` is when the source ought to have taken the
 * answer in, `settleBy` when a reply ought to have been dealt with. The clock is the only source of "too long".
 */
export const APPLY_MS = 2 * 60 * 1000
export const SETTLE_MS = 10 * 60 * 1000

const ANSWERS = new Set(['done', 'snooze', 'reply'])

/**
 * @param {object} item - an item with `presses` (this person's log lines for it, oldest first) and, when it is an open ask, `ask`
 * @returns {object | null} `{ kind: 'choice' | 'done' | 'snooze' | 'reply', press, at, label?, text?, until?, received, undoable, applyBy, settleBy }`
 */
export function answerOf(item) {
  if (item.ask === undefined && item.moved !== 'closed') return null
  const since = item.ask?.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(item.ask.since)
  const undone = new Set(item.presses.filter(row => row.action === 'undo').map(row => row.undoes))
  const last = item.presses.findLast(row => ANSWERS.has(row.action) && !undone.has(row.press) && Date.parse(row.at) >= since)
  if (last === undefined) return null
  const at = Date.parse(last.at)
  const base = { press: last.press, at: last.at, applyBy: new Date(at + APPLY_MS).toISOString(), settleBy: new Date(at + SETTLE_MS).toISOString() }
  if (last.action === 'reply') {
    const logged = item.ask?.replied
    const received = logged !== null && logged !== undefined && Date.parse(logged.at) >= at - 1000
    return { ...base, kind: 'reply', text: received ? logged.text : last.text ?? '', received, undoable: false }
  }
  const kind = last.action === 'snooze' ? 'snooze' : last.answer ? 'choice' : 'done'
  return { ...base, kind, ...(last.answer ? { label: last.answer } : {}), ...(last.until ? { until: last.until } : {}), received: false, undoable: last.inverse !== undefined }
}
