import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, readLocales, tables } from '@soffits/dsh-host-kit'

const dir = new URL('../locale/', import.meta.url)
const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'))
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

test('every locale file has every key of the base language, with the same placeholders', () => {
  const base = read(`${BASE}.json`)
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
    const file = read(name)
    assert.deepEqual(Object.keys(file.meta).sort(), Object.keys(base.meta).sort(), `${name} meta`)
    for (const [key, text] of Object.entries(base.ui)) {
      assert.equal(typeof file.ui[key], 'string', `${name} lacks ${key}`)
      assert.deepEqual(placeholders(file.ui[key]), placeholders(text), `${name} ${key} placeholders`)
    }
  }
})

test('a new language is one file, no code change; missing keys fall back to the primary tag, then the base', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'locales-'))
  try {
    cpSync(dir, copy, { recursive: true })
    writeFileSync(join(copy, 'de.json'), JSON.stringify({ meta: {}, ui: { title: 'Posteingang' } }))
    writeFileSync(join(copy, 'zh-TW.json'), JSON.stringify({ meta: {}, ui: { title: '收件匣' } }))
    writeFileSync(join(copy, 'pt-BR.json'), JSON.stringify({ meta: {}, ui: { title: 'Caixa de entrada' } }))
    writeFileSync(join(copy, 'notes.txt'), 'not a locale')
    const all = tables(await readLocales(copy))
    const base = read(`${BASE}.json`).ui
    assert.equal(all.de.title, 'Posteingang')
    assert.equal(all.de.markAll, base.markAll)
    assert.equal(all['zh-TW'].title, '收件匣')
    assert.equal(all['zh-TW'].markAll, read('zh.json').ui.markAll)
    assert.equal(all.pt.title, 'Caixa de entrada', 'a regional file also answers for its primary tag')
    assert.deepEqual(Object.keys(all).sort(), ['de', 'en', 'fr', 'pt', 'pt-BR', 'zh', 'zh-TW'])
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})
