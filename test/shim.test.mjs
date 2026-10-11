// Guards the `arp-guard` shim in shim/arp-guard: the package published under
// this package's earlier name, so that an install or a peer range that names
// `arp-guard` keeps resolving to this package.
//
// The shim is published on its own. The root build does not compile it and the
// root package does not ship it, so nothing else reads it. A shim that names
// another package or another version would install without error and export
// something else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const shimDir = path.join(root, 'shim', 'arp-guard')

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const rootPackage = readJson(path.join(root, 'package.json'))
const shim = readJson(path.join(shimDir, 'package.json'))

test('the shim is published as arp-guard, at the version of the root package', () => {
  assert.equal(shim.name, 'arp-guard')
  assert.equal(shim.version, rootPackage.version)
})

test('the shim depends on the root package alone, at exactly the root version', () => {
  assert.equal(rootPackage.name, 'agent-runtime-protection')
  assert.deepEqual(shim.dependencies, { [rootPackage.name]: rootPackage.version })
})

test('the shim carries the license and the repository of the root package', () => {
  assert.equal(shim.license, rootPackage.license)
  assert.deepEqual(shim.repository, rootPackage.repository)
})

// The entry point is run with a `require` that records what it is asked for,
// so the check does not depend on the root package being installed under its
// own name next to the shim.
test('the entry point of the shim requires the root package and exports what it gets', () => {
  assert.equal(shim.main, 'index.js')
  const source = readFileSync(path.join(shimDir, shim.main), 'utf8')
  const required = []
  const engine = {}
  const module = { exports: {} }
  new Function('module', 'exports', 'require', source)(module, module.exports, (specifier) => {
    required.push(specifier)
    return engine
  })
  assert.deepEqual(required, [rootPackage.name])
  assert.equal(module.exports, engine, 'the shim does not export what the root package exports')
})

test('the types of the shim re-export the root package', () => {
  assert.equal(shim.types, 'index.d.ts')
  const types = readFileSync(path.join(shimDir, shim.types), 'utf8')
  assert.equal(types.trim(), `export * from '${rootPackage.name}';`)
})

// npm adds package.json to every package, so with these three the shim
// publishes four files.
test('the shim publishes its entry point, its types and its README, and each exists', () => {
  assert.deepEqual([...shim.files].sort(), ['README.md', 'index.d.ts', 'index.js'])
  for (const file of shim.files) {
    assert.ok(existsSync(path.join(shimDir, file)), `shim/arp-guard/${file} does not exist`)
  }
})

// `files` in the root package.json is a list of what ships. The shim stays out
// of the root package as long as no entry takes in the shim directory.
test('the root package does not ship the shim', () => {
  assert.ok(Array.isArray(rootPackage.files), 'the root package.json has no `files` list')
  for (const entry of rootPackage.files) {
    const first = path.posix.normalize(entry).split('/')[0]
    assert.ok(!['shim', '.', '*', '**'].includes(first), `the \`files\` entry \`${entry}\` takes in the shim directory`)
  }
})
