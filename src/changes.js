/**
 * Change notices. The data folder and each person's folder are watched
 * (`fs.watch` on the directories, so a file replaced by a rename is seen as
 * well as one appended to); when one of the files that make up a person's
 * inbox (records, read marks, the summary line) changes, listeners that may
 * see that person hear the file's name, the page fetches again and push looks
 * for new records. No timer: the files' own changes are the signal. A folder
 * that appears later is picked up when the data folder reports it.
 */
import { watch } from 'node:fs'
import { join } from 'node:path'
import { createNotices } from '@soffits/dsh-plugin-sdk/host'

export const FILES = ['inbox.jsonl', 'read.json', 'summary.json']
/** Several writes in one go (an append and its status line, a rename) become one notice. */
const SETTLE_MS = 50

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {() => Promise<string[]>} options.persons - every inbox folder there is
 * @param {(message: string) => void} [options.warn]
 */
export function createChanges({ dataDir, persons, warn = () => {} }) {
  const notices = createNotices({ settleMs: SETTLE_MS })
  const watchers = new Map()      // folder name ('' for the data folder) -> FSWatcher
  let stopped = false

  function watchFolder(person) {
    if (stopped || watchers.has(person)) return
    try {
      const watcher = watch(join(dataDir, person), (_event, name) => {
        const file = name === null ? 'inbox.jsonl' : String(name)
        if (FILES.includes(file)) notices.notify(file, person)
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
        notices.notify('inbox.jsonl', person)
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

  /** Stop at once (the plugin is going away). */
  function stop() {
    stopped = true
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    notices.close()
  }

  return {
    start,
    stop,
    /**
     * Hear the names of the changed files, only for the folders `accepts` takes (omit it to hear them all).
     * @type {(send: (files: string[]) => void, accepts?: (person: string) => boolean) => () => void}
     */
    listen: notices.listen,
  }
}
