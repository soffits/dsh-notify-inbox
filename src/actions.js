/**
 * Presses on a record's buttons.
 *
 * `chat` and `link` act in the page. `done`, `snooze` and `event` become an
 * action event: appended to `<dataDir>/<person>/actions.jsonl` (the log this
 * plugin owns) and published on the channel `ui.action.<kind>` through an
 * event service when one is installed (dsh-cron-jobs provides `cronJobs`).
 * Whatever owns the notification reacts and writes a `handled` line into the
 * inbox; until then the page shows the press as pending.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** Kinds whose press is recorded here: a step's press is the person's go-ahead for what its label says. */
export const EMITTING = ['step', 'done', 'snooze', 'event']
const ACTIONS_LOG = 'actions.jsonl'

/** The event a press becomes (same shape as the practice's actions spec). */
export function actionEvent(action, { person, record, payload = {}, at = new Date(), press = randomBytes(6).toString('hex') }) {
  return {
    action: action.kind,
    id: action.id,
    payload: { ...(action.payload ?? {}), ...payload },
    person,
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { plugin: 'notify-inbox', record: record.id, key: record.key || undefined, domain: record.domain || undefined },
    press,
    ...(action.inverse === undefined ? {} : { inverse: action.inverse }),
  }
}

export const REPLY_MAX_LOGGED = 8000

/**
 * The event a typed reply becomes: the person's own words about an item, addressed to whatever writes the
 * item's source (the payload of its buttons names it) so the words land there whoever reads them.
 */
export function replyEvent({ person, record, words, writer = {}, at = new Date(), press = randomBytes(6).toString('hex') }) {
  return {
    action: 'reply',
    id: 'reply',
    payload: { ...writer, text: String(words).trim().slice(0, REPLY_MAX_LOGGED) },
    person,
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { plugin: 'notify-inbox', record: record.id, key: record.key || undefined, domain: record.domain || undefined },
    press,
  }
}

/** The way an item's buttons address their source (`payload.source` and what goes with it), from the first that has one. */
export function writerOf(actions) {
  for (const action of actions ?? []) {
    const { source, uuid, person } = action.payload ?? {}
    if (typeof source === 'string' && source !== '') return { source, ...(uuid === undefined ? {} : { uuid }), ...(person === undefined ? {} : { person }) }
  }
  return {}
}

/** The event that takes a logged press back through the inverse it declared. */
export function undoEvent(press, { at = new Date(), id = randomBytes(6).toString('hex') } = {}) {
  const { payload: wasPayload = {}, inverse } = press
  const { until: _picked, ...payload } = wasPayload
  return {
    action: 'undo',
    id: press.id,
    of: press.action,
    undoes: press.press,
    inverse: inverse.kind,
    payload: { ...payload, ...(inverse.payload ?? {}) },
    person: press.person,
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: press.source,
    press: id,
  }
}

/** What a page may add to a press: only a snooze time. */
export function pressPayload(kind, value) {
  if (kind !== 'snooze' || typeof value?.until !== 'string') return {}
  const time = Date.parse(value.until)
  return Number.isNaN(time) ? {} : { until: value.until }
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => object | undefined} options.events - the event service right now (`cronJobs`), if any
 * @param {(message: string) => void} options.warn
 */
export function createActions({ dataDir, events, warn }) {
  function publish(event) {
    const controller = events()?.controller?.()
    if (controller === undefined) return { published: false }
    try {
      const result = controller.emit({ channel: `ui.action.${event.action}`, data: event, key: event.press, source: 'notify-inbox' })
      return { published: true, matched: result?.matched?.length ?? 0 }
    } catch (error) {
      warn(`action event not published: ${error.message}`)
      return { published: false }
    }
  }

  async function record(event) {
    await mkdir(join(dataDir, event.person), { recursive: true })
    await appendFile(join(dataDir, event.person, ACTIONS_LOG), `${JSON.stringify(event)}\n`, { mode: 0o600 })
    return { event, ...publish(event) }
  }

  async function press(person, record_, action, extra) {
    if (!EMITTING.includes(action.kind)) throw new Error('This button acts in the page.')
    return record(actionEvent(action, { person, record: record_, payload: pressPayload(action.kind, extra) }))
  }

  /** A typed reply, logged and published like a press so its owner writes it down. */
  async function say(person, record_, words) {
    return record(replyEvent({ person, record: record_, words, writer: writerOf(record_.actions) }))
  }

  /** The logged lines of this person, as written. */
  async function lines(person) {
    let text
    try {
      text = await readFile(join(dataDir, person, ACTIONS_LOG), 'utf8')
    } catch {
      return []
    }
    return text.split('\n').flatMap(line => {
      try {
        return line.trim() === '' ? [] : [JSON.parse(line)]
      } catch {
        return [] // A torn line is skipped.
      }
    })
  }

  /** Take a logged press back: its inverse becomes an `undo` event. Throws with a status when it cannot be. */
  async function undo(person, pressId) {
    const all = await lines(person)
    const found = all.find(event => event.press === pressId && event.action !== 'undo')
    if (found === undefined) throw Object.assign(new Error('No such press.'), { status: 404 })
    if (typeof found.inverse?.kind !== 'string') throw Object.assign(new Error('This cannot be taken back.'), { status: 400 })
    if (all.some(event => event.action === 'undo' && event.undoes === pressId)) throw Object.assign(new Error('Already taken back.'), { status: 409 })
    return record(undoEvent(found))
  }

  /** This person's presses by record id: `[{ press, action, id, at, answer?, text?, until?, inverse?, undoes? }]`. */
  async function presses(person) {
    const out = new Map()
    for (const event of await lines(person)) {
      const id = event?.source?.record
      if (typeof id !== 'string') continue
      out.set(id, [...(out.get(id) ?? []), {
        press: event.press,
        action: event.action,
        id: event.id,
        at: event.at,
        until: event.payload?.until,
        answer: typeof event.payload?.answer === 'string' ? event.payload.answer : undefined,
        text: event.action === 'reply' && typeof event.payload?.text === 'string' ? event.payload.text : undefined,
        inverse: event.inverse,
        undoes: event.undoes,
      }])
    }
    return out
  }

  return { press, say, undo, presses }
}
