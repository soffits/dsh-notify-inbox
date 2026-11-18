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
  assert.deepEqual(out, { session: 's1', woke: true })
  const [message] = live.steered
  assert.equal(message.role, 'user')
  assert.match(message.content[0].text, /^Oak, please\n\n> Pick the lamp\n> \[Item from Inbox \(@soffits\/dsh-notify-inbox\)\]\n> White or oak\?\n> White is 39\.\n> context: /)
  assert.deepEqual(message.source, { kind: 'notify-inbox-reply', principal: { kind: 'oidc-user', channel: 'web', id: 'sub-1', name: 'Ana', issuer: 'https://id.example' } })
})

test('a stored session is loaded first; a gone one or a finished helper is refused', async () => {
  const stored = agent()
  const deps = { liveAgent: () => undefined, resolveAgent: async () => stored, readHeader: async id => (id === 's1' ? { origin: 'web' } : id === 'child' ? { origin: 'subagent' } : undefined) }
  await send(deps, { session: 's1', words: 'yes', item })
  assert.equal(stored.steered.length, 1)
  assert.equal(stored.steered[0].source.principal, undefined, 'no verified person: the owner sends it')
  await assert.rejects(send(deps, { session: 'gone', words: 'yes', item }), { status: 404 })
  await assert.rejects(send(deps, { session: 'child', words: 'yes', item }), { status: 409 })
  await assert.rejects(send(deps, { session: 's1', words: '  ', item }), { status: 400 })
})

test('the quote and the principal', () => {
  assert.match(quote({ ...item, text: '' }), /^> Pick the lamp\n> \[Item from Inbox/)
  assert.equal(principalOf(undefined), undefined)
  assert.deepEqual(principalOf({ provider: 'oidc', id: 'x' }), { kind: 'oidc-user', channel: 'web', id: 'x' })
})
