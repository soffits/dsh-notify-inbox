import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalOf, quote, send } from '../src/reply.js'

const item = { id: 'r1', title: 'Pick the lamp', text: 'White or oak?\n\nWhite is 39.', thread: 'todo:1', ask: 'todo:1' }

function agent(status = 'idle') {
  const steered = []
  return { status, session: { header: { origin: 'web' } }, steer: message => steered.push(message), steered }
}

test('a reply steers the session with the item quoted and the person as the sender', async () => {
  const live = agent()
  const out = await send({ liveAgent: () => live, resolveAgent: async () => { throw new Error('not used') }, readHeader: async () => undefined, flush: async () => true },
    { session: 's1', words: ' Oak, please ', item, identity: { provider: 'oidc', issuer: 'https://id.example', id: 'sub-1', name: 'Ana' } })
  assert.deepEqual(out, { session: 's1', woke: true, fresh: false })
  const [message] = live.steered
  assert.equal(message.role, 'user')
  assert.match(message.content[0].text, /^Oak, please\n\n> Pick the lamp\n> \[Item from Inbox \(@soffits\/dsh-notify-inbox\)\]\n> White or oak\?\n> White is 39\.\n> context: /)
  assert.deepEqual(message.source, { kind: 'notify-inbox-reply', principal: { kind: 'oidc-user', channel: 'web', id: 'sub-1', name: 'Ana', issuer: 'https://id.example' } })
})

test('a stored session is loaded first', async () => {
  const stored = agent()
  const deps = { liveAgent: () => undefined, resolveAgent: async () => stored, readHeader: async () => ({ origin: 'web' }) }
  assert.deepEqual(await send(deps, { session: 's1', words: 'yes', item }), { session: 's1', woke: true, fresh: false })
  assert.equal(stored.steered.length, 1)
  assert.equal(stored.steered[0].source.principal, undefined, 'no verified person: the owner sends it')
  await assert.rejects(send(deps, { session: 's1', words: '  ', item }), { status: 400 })
})

test('no session, a gone, archived or unopenable one, or a finished helper: a new session takes the reply', async () => {
  const opened = []
  const deps = {
    liveAgent: () => undefined,
    resolveAgent: async id => { if (id === 'broken') throw new Error('bad log'); return agent() },
    readHeader: async id => (id === 'gone' ? undefined : id === 'child' ? { origin: 'subagent' } : { origin: 'web' }),
    ended: id => id === 'old',
    openSession: async request => { opened.push(request); return `new-${opened.length}` },
    warn: () => {},
  }
  for (const session of [undefined, '', 'gone', 'old', 'child', 'broken']) {
    const out = await send(deps, { session, words: 'Oak', item, identity: { provider: 'oidc', id: 'sub-1' } })
    assert.equal(out.fresh, true, String(session))
    assert.equal(out.session, `new-${opened.length}`)
  }
  assert.equal(opened.length, 6)
  const { message, title } = opened[2]
  assert.equal(title, 'Reply: Pick the lamp')
  assert.match(message.content[0].text, /^Oak\n\n> Pick the lamp\n> \[Item from Inbox/)
  assert.match(message.content[0].text, /"asked":"gone"/, 'the session that asked is named for whoever reads it')
  assert.doesNotMatch(opened[0].message.content[0].text, /"asked"/)
  assert.deepEqual(message.source, { kind: 'notify-inbox-reply', principal: { kind: 'oidc-user', channel: 'web', id: 'sub-1' } })
})

test('without a way to open sessions, a reply that needs a new one is refused', async () => {
  const deps = { liveAgent: () => undefined, resolveAgent: async () => agent(), readHeader: async () => undefined }
  await assert.rejects(send(deps, { session: 'gone', words: 'yes', item }), { status: 503 })
})

test('the quote and the principal', () => {
  assert.match(quote({ ...item, text: '' }), /^> Pick the lamp\n> \[Item from Inbox/)
  const long = { ...item, text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') }
  assert.equal(quote(long).split('\n').length, 13, 'a few lines into the session that asked')
  assert.equal(quote(long, { fresh: true }).split('\n').length, 33, 'the whole item into a new one')
  assert.equal(principalOf(undefined), undefined)
  assert.deepEqual(principalOf({ provider: 'oidc', id: 'x' }), { kind: 'oidc-user', channel: 'web', id: 'x' })
})
