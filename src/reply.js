/**
 * A reply to an ask, put into the session that asked.
 *
 * The page posts the person's words; the route has already checked the item is
 * theirs and names a session. Here the words, with the item quoted in the
 * format the UI actions package reads back as a card, go into that session
 * through DSH's own steering: a running session sees them at its next step, an
 * idle or stored one is loaded and starts a turn with them. The sender is the
 * person the server verified (their sign-in's principal, the way the sign-in
 * plugin stamps a message typed in the Web UI), or the owner when the inbox has
 * no people mapping. Every DSH service comes in through `deps`, so the logic is
 * tested without a host.
 */
import { randomUUID } from 'node:crypto'

export const SOURCE_KIND = 'notify-inbox-reply'
export const MAX_REPLY = 8000
const QUOTED_LINES = 12
const LINE_MAX = 300

/**
 * @typedef {object} Deps
 * @property {(id: string) => any} liveAgent - the loaded Agent of a session, or undefined
 * @property {(id: string) => Promise<any>} resolveAgent - load (resume) a stored session's Agent
 * @property {(id: string) => Promise<{ origin?: string, parentSession?: string } | undefined>} readHeader - a stored session's header
 * @property {(session: any) => Promise<boolean>} [flush] - wait until the session log has the message
 * @property {<T>(fn: () => T) => T} [detached] - run outside whichever turn happens to be current
 */

const oneLine = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)

/** The item as quoted text: title, the source line, a few lines of text, its context. */
export function quote(item) {
  const lines = [oneLine(item.title, 200) || '…', '[Item from Inbox (@soffits/dsh-notify-inbox)]']
  for (const line of String(item.text ?? '').split('\n')) {
    if (lines.length >= QUOTED_LINES) break
    const text = oneLine(line, LINE_MAX)
    if (text !== '') lines.push(text)
  }
  lines.push(`context: ${JSON.stringify({ notification: item.id, ask: item.ask, thread: item.thread || undefined })}`)
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
 * Put one reply into `session`. Returns `{ session, woke }`; throws with a message the page can show.
 * @param {Deps} deps
 */
export async function send(deps, { session, words, item, identity }) {
  const text = String(words ?? '').trim()
  if (text === '') throw Object.assign(new Error('Write a reply first.'), { status: 400 })
  if (text.length > MAX_REPLY) throw Object.assign(new Error(`A reply is at most ${MAX_REPLY} characters.`), { status: 413 })
  const live = deps.liveAgent(session)
  const header = live?.session?.header ?? await deps.readHeader(session)
  if (header === undefined) throw Object.assign(new Error('The conversation that asked is gone.'), { status: 404 })
  if (header.origin === 'subagent') throw Object.assign(new Error('The conversation that asked was a helper that has finished; ask in a chat instead.'), { status: 409 })
  const principal = principalOf(identity)
  const source = principal === undefined ? { kind: SOURCE_KIND } : { kind: SOURCE_KIND, principal }
  const run = async () => {
    const agent = live ?? await deps.resolveAgent(session)
    const woke = agent.status !== 'running'
    agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: `${text}\n\n${quote(item)}` }], source })
    if (deps.flush && !(await deps.flush(agent.session))) throw new Error('the conversation did not take the reply')
    return { session, woke }
  }
  return deps.detached ? deps.detached(run) : run()
}
