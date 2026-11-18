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
  replyCwd: z.string().default('')
    .description('The folder of the new session a reply opens when the item names no conversation, or the one it names is gone or archived. Empty means the host default. A leading ~/ means the home folder.'),
  replyPreset: z.string().default('')
    .description('The agent preset of that new session. Empty means the host default.'),
  quiet: z.array(z.string()).default([])
    .description('People (person ids) whose bell never shows a count: a soft dot says something is new, so their inbox invites rather than nags.'),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataDir: string, people: Record<string, string>, peopleFile: string, peopleKey: string, vapidFile: string, vapidSubject: string, domains: Record<string, { icon: string, tone?: string }>, summaryHours: number, replyCwd: string, replyPreset: string }} config
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
  const replyCwd = config.replyCwd ? absolute(config.replyCwd) : ''
  const replyDeps = () => {
    const agents = ctx.get('agents')
    const controller = ctx.get('sessionController')
    const query = ctx.get('sessionQuery')
    if (agents === undefined || controller === undefined || query === undefined) return undefined
    const flush = session => ctx.get('sessions')?.flush?.(session) ?? Promise.resolve(true)
    return {
      liveAgent: id => agents.get(id),
      resolveAgent: async id => {
        const found = await controller.resolveAgent(id)
        if ('error' in found) throw found.error instanceof Error ? found.error : new Error(String(found.error))
        return found.agent
      },
      readHeader: async id => {
        try {
          return (await query.readSession(id))?.session
        } catch (error) {
          if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
          throw error
        }
      },
      ended: id => {
        try {
          return ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(id) === true
        } catch {
          return false
        }
      },
      // A new top-level session, the way a scheduled run with a new target opens one.
      openSession: async ({ message, title }) => {
        const { sessionId } = await controller.create({
          ...(replyCwd ? { cwd: replyCwd } : {}),
          ...(config.replyPreset ? { agentPreset: config.replyPreset } : {}),
        })
        const found = await controller.resolveAgent(sessionId)
        if ('error' in found) throw found.error instanceof Error ? found.error : new Error(String(found.error))
        const { agent } = found
        if (replyCwd) {
          try {
            await (await ctx.get('workspaceRegistry')?.resolveByPath(replyCwd))?.attachSession(sessionId)
          } catch (error) {
            warn(`session ${sessionId} did not join the workspace at ${replyCwd}: ${error.message}`)
          }
        }
        try {
          ctx.get('sessionTitle')?.rename(agent.session, title)
        } catch (error) {
          warn(`session ${sessionId} was not named: ${error.message}`)
        }
        agent.followup(message)
        if (!(await flush(agent.session))) throw new Error('the new conversation did not take the reply')
        return sessionId
      },
      flush,
      detached: fn => (agents.withoutInitiator ? agents.withoutInitiator(fn) : fn()),
      warn,
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
    quiet: config.quiet ?? [],
  })
  for (const route of routes) ctx.connection.fetch.register(route)

  push.vapid().then(() => changes.start().then(scan), error => {
    logger.error(`Web Push keys unusable, push is off: ${error.message}`)
    return changes.start()
  })
  ctx.on('dispose', () => changes.stop())
  logger.info(`inbox at ${dataDir} (${people.enabled ? 'per person' : 'single owner'})`)
}
