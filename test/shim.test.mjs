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
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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

// At the v0.3.0 tag, package.json names the hackmyagent repository in
// `repository`, `homepage` and `bugs`. The shim carries the root package's
// three, and its `homepage` and `bugs` name the repository that
// `repository.url` names.
test('the shim carries the homepage and the bugs URL of the root package, and both name its repository', () => {
  assert.equal(shim.homepage, rootPackage.homepage)
  assert.deepEqual(shim.bugs, rootPackage.bugs)
  const repository = rootPackage.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  assert.equal(shim.homepage, `${repository}#readme`)
  assert.deepEqual(shim.bugs, { url: `${repository}/issues` })
})

// The shim is loaded the way an install loads it: by name, from a
// `node_modules` directory that holds a copy of the files it publishes. Next
// to the copy, under the root package's name, is a stand-in whose entry point
// is a JSON file, so the check does not depend on the root package being built
// or installed, and the test evaluates no source itself. Node lists under
// `children` the modules a module loads that are not built in.
test('the entry point of the shim requires the root package and exports what it gets', () => {
  assert.equal(shim.main, 'index.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'arp-guard-shim-'))
  try {
    const copy = path.join(dir, 'node_modules', shim.name)
    const standIn = path.join(dir, 'node_modules', rootPackage.name)
    mkdirSync(copy, { recursive: true })
    for (const file of ['package.json', ...shim.files]) copyFileSync(path.join(shimDir, file), path.join(copy, file))
    mkdirSync(standIn)
    writeFileSync(path.join(standIn, 'package.json'), JSON.stringify({ name: rootPackage.name, main: 'engine.json' }))
    writeFileSync(path.join(standIn, 'engine.json'), '{}')

    const installed = createRequire(path.join(dir, 'index.js'))
    const exported = installed(shim.name)
    const entry = installed.cache[installed.resolve(shim.name)]
    assert.equal(path.relative(realpathSync(dir), entry.filename), path.join('node_modules', shim.name, shim.main))
    assert.deepEqual(
      entry.children.map((child) => child.filename),
      [installed.resolve(rootPackage.name)],
      'the shim loads something other than the root package',
    )
    assert.equal(exported, installed(rootPackage.name), 'the shim does not export what the root package exports')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

// `npm version` writes the new version to package.json and package-lock.json,
// then runs the `version` script, then commits and tags. While it moved the
// root package alone, the first two checks in this file failed after
// `npm version patch --no-git-tag-version`; `npm test` runs this file, and the
// release workflow runs `npm test` before it publishes. The bump is made as a
// maintainer makes it, in a scratch git repository holding a copy of the files
// `npm version` and the `version` script read and write. git and npm get PATH
// from the runner's environment and a scratch HOME, so they read no
// configuration from the user's home directory, and git reads none from the
// system's.
const VERSIONED_FILES = ['package.json', 'package-lock.json', 'scripts/version-shim.mjs', 'shim/arp-guard/package.json']

function bumpInScratchRepository(npmArgs, check) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arp-guard-version-'))
  try {
    const home = path.join(dir, 'home')
    const repo = path.join(dir, 'repo')
    mkdirSync(home)
    for (const file of VERSIONED_FILES) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      copyFileSync(path.join(root, file), path.join(repo, file))
    }
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: repo,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'version test',
          GIT_AUTHOR_EMAIL: 'version-test@example.invalid',
          GIT_COMMITTER_NAME: 'version test',
          GIT_COMMITTER_EMAIL: 'version-test@example.invalid',
          npm_config_update_notifier: 'false',
        },
      })
      assert.equal(result.status, 0, `\`${command} ${args.join(' ')}\` failed: ${result.error ?? result.stderr}`)
      return result.stdout
    }
    run('git', ['init', '-q'])
    run('git', ['add', '--', ...VERSIONED_FILES])
    run('git', ['commit', '-q', '-m', 'before the bump'])
    run('npm', ['version', ...npmArgs])
    const bumped = readJson(path.join(repo, 'package.json')).version
    assert.notEqual(bumped, rootPackage.version, `\`npm version ${npmArgs.join(' ')}\` did not change the version`)
    check({ run, repo, bumped })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('npm version gives the shim the new version and pins it, in the commit and tag it makes', () => {
  bumpInScratchRepository(['patch'], ({ run, bumped }) => {
    const tags = run('git', ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean)
    assert.equal(tags.length, 1, `the bump commit carries ${tags.length} tags`)
    const tagged = (file) => JSON.parse(run('git', ['show', `${tags[0]}:${file}`]))
    assert.equal(tagged('package.json').version, bumped)
    assert.equal(tagged('shim/arp-guard/package.json').version, bumped)
    assert.deepEqual(tagged('shim/arp-guard/package.json').dependencies, { [rootPackage.name]: bumped })
    assert.equal(run('git', ['status', '--porcelain']), '', '`npm version` left a change out of its commit')
  })
})

test('npm version --no-git-tag-version gives the shim the new version and pins it', () => {
  bumpInScratchRepository(['patch', '--no-git-tag-version'], ({ repo, bumped }) => {
    const bumpedShim = readJson(path.join(repo, 'shim', 'arp-guard', 'package.json'))
    assert.equal(bumpedShim.version, bumped)
    assert.deepEqual(bumpedShim.dependencies, { [rootPackage.name]: bumped })
  })
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
