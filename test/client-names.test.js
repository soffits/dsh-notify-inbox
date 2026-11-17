import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const fixture = async name => new Set(JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).exports)

test('every DSH primitive the page takes exists in the DSH it supports', async () => {
  const exported = await fixture('dsh-client-ui-primitives-0.2.2-rc.1.json')
  const [, list] = client.match(/const \{([^}]*)\} = require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  const used = list.split(',').map(name => name.trim()).filter(Boolean)
  assert.ok(used.length > 3)
  assert.deepEqual(used.filter(name => !exported.has(name)), [])
})

test('every kit piece the page uses is one the kit provides', async () => {
  const provided = await fixture('dsh-ui-kit-0.1.1.json')
  const used = [...new Set([...client.matchAll(/\bkit\.([A-Za-z]+)\b/g)].map(match => match[1]))]
  assert.ok(used.length > 5)
  assert.deepEqual(used.filter(name => !provided.has(name)), [])
})
