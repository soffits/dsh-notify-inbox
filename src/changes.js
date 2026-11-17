/**
 * Change notices for open pages. While anyone listens, the files that make up
 * a person's inbox (records, read marks, presses, the summary line) are
 * looked at every `intervalMs`; when one changed, every listener allowed to
 * see that person hears a short notice and the page fetches again. A stat
 * per file is cheap and, unlike fs.watch, behaves the same on every file
 * system and through a replaced file. Nothing runs while nobody listens.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const FILES = ['inbox.jsonl', 'read.json', 'actions.jsonl', 'summary.json']

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => Promise<string[]>} options.persons - every inbox folder there is
 * @param {number} [options.intervalMs]
 */
export function createChanges({ dataDir, persons, intervalMs = 2000 }) {
  const listeners = new Set()
  const seen = new Map()       // person -> signature
  let running = false
  let timer

  async function signature(person) {
    const parts = await Promise.all(FILES.map(name => stat(join(dataDir, person, name)).then(
      info => `${info.ino}:${info.size}:${info.mtimeMs}`,
      () => '-')))
    return parts.join('|')
  }

  /** One look at every folder; the loop goes on while anyone listens and ends by itself after. */
  async function tick() {
    try {
      for (const person of await persons()) {
        const now = await signature(person)
        const before = seen.get(person)
        seen.set(person, now)
        if (before === undefined || before === now) continue
        for (const listener of listeners) if (listener.folders === null || listener.folders.includes(person)) listener.send(person)
      }
    } finally {
      if (listeners.size > 0) {
        timer = setTimeout(tick, intervalMs)
      } else {
        running = false
        seen.clear()
      }
    }
  }

  /**
   * Hear about changes to these folders (null: every folder, for an owner who sees them all).
   * @returns {() => void} stop listening
   */
  function listen(folders, send) {
    const listener = { folders, send }
    listeners.add(listener)
    if (!running) {
      running = true
      timer = setTimeout(tick, 0)
    }
    return () => listeners.delete(listener)
  }

  /** Stop at once (the plugin is going away). */
  function stop() {
    listeners.clear()
    clearTimeout(timer)
    running = false
  }

  return { listen, stop, tick }
}
