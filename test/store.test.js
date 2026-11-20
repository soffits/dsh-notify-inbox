import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/store.js'

let dir

const line = (id, time) => `${JSON.stringify({ id, time, title: id })}\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notify-store-'))
  await mkdir(join(dir, 'ana'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

test('two reads at once see each record once', async () => {
  const path = join(dir, 'ana', 'inbox.jsonl')
  await writeFile(path, line('r1', '2026-11-17T15:00:00Z') + line('r2', '2026-11-17T15:01:00Z'))
  const store = createStore(dir)
  const [first, second] = await Promise.all([store.records('ana'), store.records('ana')])
  assert.deepEqual(first.records.map(row => row.id), ['r1', 'r2'])
  assert.deepEqual(second.records.map(row => row.id), ['r1', 'r2'])

  await appendFile(path, line('r3', '2026-11-17T15:02:00Z'))
  await Promise.all([store.records('ana'), store.records('ana')])
  assert.deepEqual((await store.records('ana')).records.map(row => row.id), ['r1', 'r2', 'r3'])
})

test('two read marks at once both land and nothing fails', async () => {
  await writeFile(join(dir, 'ana', 'inbox.jsonl'), line('r1', '2026-11-17T15:00:00Z') + line('r2', '2026-11-17T15:01:00Z'))
  const store = createStore(dir)
  await Promise.all([store.setRead('ana', ['r1'], true), store.setRead('ana', ['r2'], true)])
  const marks = JSON.parse(await readFile(join(dir, 'ana', 'read.json'), 'utf8'))
  assert.deepEqual([...marks.read].sort(), ['r1', 'r2'])
  assert.deepEqual((await readdir(join(dir, 'ana'))).filter(name => name.endsWith('.tmp')), [])
})
