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

  /** This person's presses by record id: `[{ press, action, id, at, answer?, until?, inverse?, undoes? }]`. */
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
        inverse: event.inverse,
        undoes: event.undoes,
      }])
    }
    return out
  }

  return { press, presses }
}
