/**
 * Change notices. The data folder and each person's folder are watched
 * (`fs.watch` on the directories, so a file replaced by a rename is seen as
 * well as one appended to); when one of the files that make up a person's
 * inbox (records, read marks, presses, the summary line, the asks) changes,
 * every listener allowed to see that person hears a short notice and the page
 * fetches again, and `onChange` runs (push looks for new records). No timer:
 * the files' own changes are the signal. A folder that appears later is
 * picked up when the data folder reports it.
 */
import { watch } from 'node:fs'
import { join } from 'node:path'

export const FILES = ['inbox.jsonl', 'read.json', 'actions.jsonl', 'summary.json', 'asks.json']
const SETTLE_MS = 50

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => Promise<string[]>} options.persons - every inbox folder there is
 * @param {(person: string, file: string) => void} [options.onChange] - also called for each change
 * @param {(message: string) => void} [options.warn]
 */
export function createChanges({ dataDir, persons, onChange = () => {}, warn = () => {} }) {
  const listeners = new Set()
  const watchers = new Map()      // folder name ('' for the data folder) -> FSWatcher
  const pending = new Map()       // person -> { timer, files }
  let stopped = false

  function notify(person, file) {
    const due = pending.get(person) ?? { timer: undefined, files: new Set() }
    due.files.add(file)
    clearTimeout(due.timer)
    // Several writes in one go (an append and its status line, a rename) become one notice.
    due.timer = setTimeout(() => {
      pending.delete(person)
      for (const listener of listeners) if (listener.folders === null || listener.folders.includes(person)) listener.send(person)
      for (const name of due.files) onChange(person, name)
    }, SETTLE_MS)
    pending.set(person, due)
  }

  function watchFolder(person) {
    if (stopped || watchers.has(person)) return
    try {
      const watcher = watch(join(dataDir, person), (_event, name) => {
        const file = name === null ? null : String(name)
        if (file === null || FILES.includes(file)) notify(person, file ?? 'inbox.jsonl')
      })
      watcher.on('error', error => {
        warn(`stopped watching ${person}: ${error.message}`)
        watcher.close()
        watchers.delete(person)
      })
      watchers.set(person, watcher)
    } catch (error) {
      if (error.code !== 'ENOENT') warn(`cannot watch ${person}: ${error.message}`)
    }
  }

  async function sync() {
    for (const person of await persons()) {
      if (!watchers.has(person)) {
        watchFolder(person)
        notify(person, 'inbox.jsonl')
      }
    }
  }

  /** Start watching: the data folder for new people, and every person's folder. */
  async function start() {
    if (stopped || watchers.has('')) return
    try {
      const top = watch(dataDir, () => { sync().catch(error => warn(`inbox folders not read: ${error.message}`)) })
      top.on('error', error => warn(`stopped watching the inbox folder: ${error.message}`))
      watchers.set('', top)
    } catch (error) {
      warn(`cannot watch ${dataDir}: ${error.message}`)
    }
    for (const person of await persons()) watchFolder(person)
  }

  /**
   * Hear about changes to these folders (null: every folder, for an owner who sees them all).
   * @returns {() => void} stop listening
   */
  function listen(folders, send) {
    const listener = { folders, send }
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Stop at once (the plugin is going away). */
  function stop() {
    stopped = true
    listeners.clear()
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    for (const { timer } of pending.values()) clearTimeout(timer)
    pending.clear()
  }

  return { start, listen, stop }
}
