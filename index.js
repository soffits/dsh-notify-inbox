/**
 * DeepSeek Harness Host plugin: a notification inbox.
 *
 * A notification router outside DSH files each message as one JSON line per
 * person (`<dataDir>/<person>/inbox.jsonl`). This plugin shows each signed-in
 * person their own inbox with read and unread, sends Web Push to the browsers
 * they subscribed, and turns presses on a notification's buttons into events.
 * It holds no credentials but its own VAPID key and contacts nothing but the
 * push services the subscribed browsers chose.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createPeople, expandHome } from './src/access.js'
import { createActions } from './src/actions.js'
import { createPush } from './src/push.js'
import { createRoutes } from './src/routes.js'
import { createStore } from './src/store.js'

export const name = 'dsh-notify-inbox'
export const inject = ['connection']

const serviceWorker = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')

export const Config = z.object({
  dataDir: z.string().required()
    .description('The folder the notification router files into: <dataDir>/<person>/inbox.jsonl. Read marks, the action log and push subscriptions are kept in it too. A leading ~/ means the home folder.'),
  people: z.dict(z.string()).default({})
    .description('Verified user id (from the sign-in plugin, such as an OIDC sub) → person id (the inbox folder name). With any mapping configured, each person sees only their own inbox.'),
  peopleFile: z.string().default('')
    .description('A JSON file with more of the same mapping, re-read when it changes. Entries in people win.'),
  peopleKey: z.string().default('')
    .description('The top-level key in peopleFile that holds the mapping. Empty means the whole file is the mapping.'),
  vapidFile: z.string().default('')
    .description('Where the Web Push (VAPID) key pair is kept; made on first start, mode 600. Default: .push/vapid.json in dataDir.'),
  vapidSubject: z.string().default('mailto:admin@example.invalid')
    .description('A mailto: or https: contact that push services can reach about this server.'),
  pollSeconds: z.natural().min(2).max(3600).default(5)
    .description('How often new records are looked for (to push them), and how often an open page refreshes its count (at least 15 s).'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataDir: string, people: Record<string, string>, peopleFile: string, peopleKey: string, vapidFile: string, vapidSubject: string, pollSeconds: number }} config
 */
export function apply(ctx, config) {
  const logger = ctx.logger('notify-inbox')
  const home = homedir()
  const absolute = path => {
    const expanded = expandHome(path, home)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  const dataDir = absolute(config.dataDir)
  const warn = message => logger.warn(message)
  const people = createPeople({
    people: config.people ?? {},
    peopleFile: config.peopleFile ? absolute(config.peopleFile) : '',
    peopleKey: config.peopleKey ?? '',
  }, { warn })
  const store = createStore(dataDir)
  const push = createPush({
    dataDir,
    vapidFile: config.vapidFile ? absolute(config.vapidFile) : join(dataDir, '.push', 'vapid.json'),
    subject: config.vapidSubject,
    perPerson: () => people.enabled,
    warn,
  })
  const actions = createActions({ dataDir, events: () => ctx.get('cronJobs'), warn })
  const pollSeconds = config.pollSeconds ?? 5
  const routes = createRoutes({ store, people, push, actions, identity: () => ctx.get('requestIdentity'), serviceWorker, pollSeconds: Math.max(pollSeconds, 15) })
  for (const route of routes) ctx.connection.fetch.register(route)

  let stopped = false
  let timer
  const scan = async () => {
    try {
      await push.scan(await store.persons())
    } catch (error) {
      warn(`push scan failed: ${error.message}`)
    }
    if (!stopped) timer = setTimeout(scan, pollSeconds * 1000)
  }
  push.vapid().then(() => scan(), error => logger.error(`Web Push keys unusable, push is off: ${error.message}`))
  ctx.on('dispose', () => {
    stopped = true
    clearTimeout(timer)
  })
  logger.info(`inbox at ${dataDir} (${people.enabled ? 'per person' : 'single owner'})`)
}
