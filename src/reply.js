/**
 * A reply to an ask, put into the session that asked, or into a new one.
 *
 * The page posts the person's words; the route has already checked the item is
 * theirs. The words, with the item quoted in the format the UI actions package
 * reads back as a card, go into the session that asked through DSH's own
 * steering: a running session sees them at its next step, an idle or stored
 * one is loaded and starts a turn with them. When the item names no session,
 * or the one it names is gone, archived or a helper that has finished, the
 * reply opens a new top-level session instead, with the whole item quoted, so
 * whoever reads it there can act on it. The sender is the person the server
 * verified (their sign-in's principal, the way the sign-in plugin stamps a
 * message typed in the Web UI), or the owner when the inbox has no people
 * mapping. Every DSH service comes in through `deps`, so the logic is tested
 * without a host.
 */
import { randomUUID } from 'node:crypto'

export const SOURCE_KIND = 'notify-inbox-reply'
export const MAX_REPLY = 8000
const QUOTED_LINES = 12
const FRESH_LINES = 60
const LINE_MAX = 300

/**
 * @typedef {object} Deps
 * @property {(id: string) => any} liveAgent - the loaded Agent of a session, or undefined
 * @property {(id: string) => Promise<any>} resolveAgent - load (resume) a stored session's Agent
 * @property {(id: string) => Promise<{ origin?: string, parentSession?: string } | undefined>} readHeader - a stored session's header
 * @property {(id: string) => boolean} [ended] - whether the session was archived
 * @property {(request: { message: object, title: string }) => Promise<string>} [openSession] - open a new top-level session with this first message; its id
 * @property {(session: any) => Promise<boolean>} [flush] - wait until the session log has the message
 * @property {<T>(fn: () => T) => T} [detached] - run outside whichever turn happens to be current
 * @property {(message: string) => void} [warn]
 */

const oneLine = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)

/**
 * The item as quoted text: title, the source line, its text, its context. A
 * reply into the session that asked quotes a few lines; one that opens a new
 * session quotes the whole item and the session that asked, since the new one
 * knows nothing else.
 */
export function quote(item, { fresh = false } = {}) {
  const max = fresh ? FRESH_LINES : QUOTED_LINES
  const lines = [oneLine(item.title, 200) || '…', '[Item from Inbox (@soffits/dsh-notify-inbox)]']
  for (const line of String(item.text ?? '').split('\n')) {
    if (lines.length >= max) break
    const text = oneLine(line, LINE_MAX)
    if (text !== '') lines.push(text)
  }
  const context = { notification: item.id, ask: item.ask, thread: item.thread || undefined }
  if (fresh && item.asked) context.asked = item.asked
  lines.push(`context: ${JSON.stringify(context)}`)
  return lines.map(line => `> ${line}`).join('\n')
}

/** The sender of a reply: the verified person as their sign-in names them, or none (the owner). */
export function principalOf(identity) {
  if (identity === null || identity === undefined || typeof identity.id !== 'string') return undefined
  const principal = { kind: `${identity.provider || 'web'}-user`, channel: 'web', id: identity.id }
  if (identity.name) principal.name = String(identity.name)
  if (identity.issuer) principal.issuer = String(identity.issuer)
  return principal
}

/**
 * The loaded Agent of `session` if a reply can still go there: it exists, is
 * not archived and is not a helper. Undefined otherwise.
 * @param {Deps} deps
 */
async function existing(deps, session) {
  if (typeof session !== 'string' || session === '') return undefined
  if (deps.ended?.(session)) return undefined
  const live = deps.liveAgent(session)
  const header = live?.session?.header ?? await deps.readHeader(session)
  if (header === undefined || header.origin === 'subagent') return undefined
  if (live !== undefined) return live
  try {
    return await deps.resolveAgent(session)
  } catch (error) {
    deps.warn?.(`session ${session} could not be opened for a reply, a new one takes it: ${error.message}`)
    return undefined
  }
}

/**
 * Put one reply into `session`, or into a new session when that one cannot
 * take it. Returns `{ session, woke, fresh }`; throws with a message the page can show.
 * @param {Deps} deps
 */
export async function send(deps, { session, words, item, identity }) {
  const text = String(words ?? '').trim()
  if (text === '') throw Object.assign(new Error('Write a reply first.'), { status: 400 })
  if (text.length > MAX_REPLY) throw Object.assign(new Error(`A reply is at most ${MAX_REPLY} characters.`), { status: 413 })
  const principal = principalOf(identity)
  const source = principal === undefined ? { kind: SOURCE_KIND } : { kind: SOURCE_KIND, principal }
  const run = async () => {
    const agent = await existing(deps, session)
    if (agent !== undefined) {
      const woke = agent.status !== 'running'
      agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `${text}\n\n${quote(item)}` }], source })
      if (deps.flush && !(await deps.flush(agent.session))) throw new Error('the conversation did not take the reply')
      return { session, woke, fresh: false }
    }
    if (deps.openSession === undefined) throw Object.assign(new Error('The conversation that asked is gone, and this DSH cannot open a new one.'), { status: 503 })
    const quoted = quote({ ...item, asked: typeof session === 'string' && session !== '' ? session : undefined }, { fresh: true })
    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: `${text}\n\n${quoted}` }], source }
    const opened = await deps.openSession({ message, title: oneLine(`Reply: ${oneLine(item.title, 200) || '…'}`, 80) })
    return { session: opened, woke: true, fresh: true }
  }
  return deps.detached ? deps.detached(run) : run()
}
