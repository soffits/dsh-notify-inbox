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
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createPeople, expandHome } from './src/access.js'
import { createActions } from './src/actions.js'
import { createChanges } from './src/changes.js'
import { TONES, domainMap } from './src/domains.js'
import { createPush } from './src/push.js'
import { createRoutes } from './src/routes.js'
import { createStore } from './src/store.js'
import { readLocales, tables } from './src/locales.js'
import { send as sendReply } from './src/reply.js'

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
  domains: z.dict(z.object({
    icon: z.string().description('A Lucide icon name, such as plane or heart-pulse.'),
    tone: z.union([...TONES]).description('A colour this domain keeps wherever it shows. Usually left out: the group gives the colour.'),
  })).default({})
    .description('How each domain (the record\'s domain field) is drawn, on top of the built-in defaults (mail, money, health, travel, home...).'),
  summaryHours: z.natural().min(1).max(168).default(12)
    .description('How long the summary line (<dataDir>/<person>/summary.json) is shown after it was written.'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataDir: string, people: Record<string, string>, peopleFile: string, peopleKey: string, vapidFile: string, vapidSubject: string, domains: Record<string, { icon: string, tone?: string }>, summaryHours: number }} config
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
  const localeDir = fileURLToPath(new URL('./locale/', import.meta.url))
  const strings = () => readLocales(localeDir).then(tables)
  // Replies reach sessions through DSH's own services, looked up when one is sent.
  const replyDeps = () => {
    const agents = ctx.get('agents')
    const controller = ctx.get('sessionController')
    const query = ctx.get('sessionQuery')
    if (agents === undefined || controller === undefined || query === undefined) return undefined
    return {
      liveAgent: id => agents.get(id),
      resolveAgent: async id => {
        const found = await controller.resolveAgent(id)
        if ('error' in found) throw Object.assign(new Error('The conversation that asked could not be opened.'), { status: 404 })
        return found.agent
      },
      readHeader: async id => (await query.readSession(id))?.session,
      flush: session => ctx.get('sessions')?.flush?.(session) ?? Promise.resolve(true),
      detached: fn => (agents.withoutInitiator ? agents.withoutInitiator(fn) : fn()),
    }
  }
  const reply = async request => {
    const deps = replyDeps()
    if (deps === undefined) throw Object.assign(new Error('Replies need a DSH that lets plugins reach its sessions.'), { status: 503 })
    return sendReply(deps, request)
  }
  // New records are pushed when the inbox file changes; one scan at a time, and one more if a change came meanwhile.
  let scanning = null
  let again = false
  const scan = async () => {
    if (scanning !== null) { again = true; return }
    scanning = (async () => {
      do {
        again = false
        try {
          await push.scan(await store.persons())
        } catch (error) {
          warn(`push scan failed: ${error.message}`)
        }
      } while (again)
    })()
    await scanning
    scanning = null
  }
  const changes = createChanges({ dataDir, persons: () => store.persons(), warn, onChange: (_person, file) => { if (file === 'inbox.jsonl') scan() } })
  const routes = createRoutes({
    store, people, push, actions, changes,
    identity: () => ctx.get('requestIdentity'),
    serviceWorker,
    strings,
    reply,
    domains: domainMap(config.domains ?? {}),
    summaryHours: config.summaryHours ?? 12,
  })
  for (const route of routes) ctx.connection.fetch.register(route)

  push.vapid().then(() => changes.start().then(scan), error => {
    logger.error(`Web Push keys unusable, push is off: ${error.message}`)
    return changes.start()
  })
  ctx.on('dispose', () => changes.stop())
  logger.info(`inbox at ${dataDir} (${people.enabled ? 'per person' : 'single owner'})`)
}
