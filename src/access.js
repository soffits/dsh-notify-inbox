/**
 * Who is asking, and which person's inbox that is.
 *
 * The caller comes from a `requestIdentity` service, if one is installed: any
 * plugin that verifies the person behind an `/api` request can provide it
 * (`current()` returns `{ id, ... }` or null). The verified user id maps to a
 * person id through the configured mapping.
 *
 * Two modes:
 * - people: a mapping is configured. A request needs a verified identity that
 *   maps to a person, and sees only that person's inbox. Without an identity
 *   provider nothing is shown.
 * - owner: no mapping. Everyone DSH lets in is its owner and sees every inbox,
 *   which is what a single-person DSH wants.
 */
import { readFile, stat } from 'node:fs/promises'

/** Person ids compare without regard to case or surrounding space. */
export function personKey(value) {
  return typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : ''
}

/** Expand a leading `~/` to the home folder. */
export function expandHome(path, home) {
  return typeof path === 'string' && (path === '~' || path.startsWith('~/')) ? home + path.slice(1) : path
}

/**
 * The configured user id → person id mapping, re-read from `peopleFile`
 * whenever that file changes. A file that can't be read or parsed maps nobody
 * (and is reported once per change), so a broken file never widens access.
 */
export function createPeople({ people = {}, peopleFile = '', peopleKey = '' }, { warn = () => {} } = {}) {
  const inline = Object.entries(people)
  const enabled = inline.length > 0 || peopleFile !== ''
  let cached = { tag: undefined, entries: [] }

  async function fromFile() {
    if (peopleFile === '') return []
    let tag
    try {
      const info = await stat(peopleFile)
      tag = `${info.size}:${info.mtimeMs}`
    } catch (error) {
      tag = `error:${error.code}`
    }
    if (tag === cached.tag) return cached.entries
    let entries = []
    try {
      let value = JSON.parse(await readFile(peopleFile, 'utf8'))
      if (peopleKey !== '') value = value?.[peopleKey]
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(peopleKey ? `no object at key ${peopleKey}` : 'not a JSON object')
      entries = Object.entries(value).filter(([, person]) => typeof person === 'string')
    } catch (error) {
      warn(`people file ${peopleFile}: ${error.message}; nobody is mapped from it`)
    }
    cached = { tag, entries }
    return entries
  }

  return {
    enabled,
    /** The person id for a verified user id, or undefined. Inline entries win over the file. */
    async personFor(userId) {
      if (typeof userId !== 'string' || userId === '') return undefined
      const map = new Map([...(await fromFile()), ...inline])
      const person = map.get(userId)
      return person === undefined ? undefined : personKey(person)
    },
  }
}

/**
 * Decide who the current request is. Returns `{ mode: 'owner' }`,
 * `{ mode: 'people', person }` (person may be undefined: sees nothing) or
 * `{ mode: 'people', unavailable: true }` when a mapping is configured but no
 * identity provider is installed.
 */
export async function viewerOf(people, identityService) {
  if (!people.enabled) return { mode: 'owner' }
  if (identityService === undefined || typeof identityService?.current !== 'function') return { mode: 'people', unavailable: true }
  const identity = identityService.current()
  return { mode: 'people', person: await people.personFor(identity?.id) }
}
