import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// DSH's client module loader keys a package-local chunk by its owner package and
// the chunk's file name (`{ id: <package>, chunk: 'client.<name>.js' }`), the way
// its own built chunks register; the name must match its CLIENT_CHUNK pattern.
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function run(file) {
  const registrations = []
  const window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
  vm.runInNewContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { window, document: undefined })
  return registrations
}

test('the actions chunk registers as a chunk of this package, the way DSH expects', () => {
  const [registration, ...rest] = run('client.actions.js')
  assert.equal(rest.length, 0)
  assert.equal(registration.id, pkg.name)
  assert.equal(registration.chunk, 'client.actions.js')
  assert.match(registration.chunk, CLIENT_CHUNK)
  assert.ok(pkg.files.includes(registration.chunk), 'the chunk ships in the package')
  const exports = registration.factory()
  assert.equal(typeof exports.createActions, 'function')
  assert.equal(typeof exports.chatText, 'function')
})

test('the client entry registers under the package name and asks for the chunk by its file name', () => {
  const [registration] = run('client.js')
  assert.equal(registration.id, pkg.name)
  assert.equal(registration.chunk, undefined)
  assert.match(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), /require\.async\('\.\/client\.actions\.js'\)/)
})

test('two plugins\' copies of the actions chunk load in one page without colliding', () => {
  // DSH runs chunks as classic scripts in one global scope; a top-level const in two copies would throw.
  const registrations = []
  const context = vm.createContext({ window: { __ModuleLoader__: { load: registration => registrations.push(registration) } }, document: undefined })
  const source = readFileSync(new URL('../client.actions.js', import.meta.url), 'utf8')
  const other = source.replace(`const OWNER = '${pkg.name}'`, "const OWNER = '@example/other-plugin'")
  assert.notEqual(other, source)
  vm.runInContext(source, context)
  vm.runInContext(other, context)
  assert.deepEqual(registrations.map(r => r.id), [pkg.name, '@example/other-plugin'])
})
