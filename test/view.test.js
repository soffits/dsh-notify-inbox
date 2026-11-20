import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIVE_IDLE_MS, buildItems, countItems, groupOf, liveNow } from '../src/view.js'
import { attentionOf, normalize } from '../src/store.js'

const NOW = Date.parse('2026-11-17T18:00:00Z')
const row = (id, extra = {}) => ({ ...normalize({ id, time: '2026-11-17T17:00:00Z', ...extra }, 'ana'), read: false })

test('a record without attention is grouped the way the router documents', () => {
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', lane: 'interrupt' }, 'ana')), 'urgent')
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z' }, 'ana')), 'info')
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', handled: 'Done for you.' }, 'ana')), 'handled')
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', live: { until: 'soon' } }, 'ana')), 'live')
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', attention: 'urgent' }, 'ana')), 'urgent')
  assert.equal(attentionOf(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', attention: 'later' }, 'ana')), 'info')
  assert.deepEqual(normalize({ id: 'a', time: '2026-11-17T17:00:00Z', live: { progress: { from: '2026-11-18T00:00:00Z', to: '2026-11-17T00:00:00Z' } } }, 'ana').live, {})
})

test('a live item without an end stops being live after a quiet spell', () => {
  const live = row('l', { thread: 't', live: {} })
  assert.equal(liveNow(live, NOW), true)
  assert.equal(liveNow(live, Date.parse(live.time) + LIVE_IDLE_MS + 1), false)
  assert.deepEqual(groupOf(live, Date.parse(live.time) + LIVE_IDLE_MS + 1), { group: 'info', moved: 'ended' })
})

test('items are ordered newest first whatever their group, and counted', () => {
  const items = buildItems([
    row('i2', { time: '2026-11-17T17:30:00Z' }),
    row('n1', { lane: 'interrupt', time: '2026-11-17T17:10:00Z' }),
    row('i1', { time: '2026-11-17T17:00:00Z' }),
  ], NOW)
  assert.deepEqual(items.map(item => item.id), ['i2', 'n1', 'i1'])
  assert.deepEqual(countItems(items), { groups: { urgent: 1, live: 0, handled: 0, info: 2 }, unread: 3 })
})
