import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { apply } from '../index.js'

const watchHandles = () => process.getActiveResourcesInfo().filter(kind => kind === 'FSEventWrap').length

// Cordis 4 has no 'dispose' event: a listener on it never runs. Only effects are torn down.
function fakeContext() {
  const disposers = []
  const routes = []
  const logger = { info() {}, warn() {}, error() {} }
  return {
    ctx: {
      logger: () => logger,
      get: () => null,
      connection: { fetch: { register: route => routes.push(route) } },
      on() { return () => true },
      effect(execute) { disposers.push(execute()) },
    },
    routes,
    unload: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

test('the folder watchers close when the plugin unloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-life-'))
  await mkdir(join(dir, 'ana'))
  const before = watchHandles()
  const { ctx, unload } = fakeContext()
  try {
    apply(ctx, { dataDir: dir, people: {}, domains: {}, quiet: [], vapidSubject: 'mailto:a@example.org' })
    for (let wait = 0; wait < 100 && watchHandles() < before + 2; wait++) await sleep(20)
    assert.ok(watchHandles() >= before + 2, 'watchers started')
    unload()
    await sleep(20)
    assert.equal(watchHandles(), before)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an open events stream ends when the plugin unloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-life-'))
  const { ctx, routes, unload } = fakeContext()
  try {
    apply(ctx, { dataDir: dir, people: {}, domains: {}, quiet: [], vapidSubject: 'mailto:a@example.org' })
    const events = routes.find(route => route.path.endsWith('/events'))
    const reader = (await events.fetch(new Request('https://dsh.example/api/notify-inbox/events'))).body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /: open/)
    unload()
    const next = await Promise.race([reader.read(), sleep(1000).then(() => 'still open')])
    assert.equal(next.done, true, 'the page reconnects to the next instance instead of hanging on this one')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
