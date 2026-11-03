// Guards the form in which the tracked files cite the telemetry commands: the
// scoped form `npx @opena2a/aim-sdk telemetry <subcommand>`. Every file git
// tracks is read as bytes, and the test fails when one of them contains the
// unscoped form, naming each such path.
//
// The unscoped form is built from two fragments when the test runs, so this
// file does not contain it and is read like every other tracked file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const scopedForm = 'npx @opena2a/aim-sdk telemetry <subcommand>'
const unscopedForm = Buffer.from(['npx', 'aim-arp'].join(' '))

// The paths, relative to the repository root, that `git ls-files` lists.
function trackedPaths() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root })
  const precondition = 'this test reads the tracked files of a git checkout'
  assert.equal(result.error, undefined, `\`git ls-files\` did not run (${result.error?.message}); ${precondition}`)
  assert.equal(result.status, 0, `\`git ls-files\` exited ${result.status} (${String(result.stderr).trim()}); ${precondition}`)
  const entries = result.stdout.toString('utf8').split('\0')
  // Each entry ends in a NUL, so the last piece of the split is empty.
  assert.equal(entries.pop(), '', 'the output of `git ls-files -z` does not end in a NUL')
  return entries
}

// The paths of the files, given as { path, bytes } pairs, whose bytes contain
// the unscoped form.
function pathsWithUnscopedForm(files) {
  return files.filter((file) => file.bytes.includes(unscopedForm)).map((file) => file.path)
}

test('no file git tracks contains the unscoped npx form', () => {
  const listed = trackedPaths()
  for (const required of ['docs/install.md', 'package.json']) {
    assert.ok(listed.includes(required), `\`git ls-files\` does not list ${required}`)
  }
  const files = []
  for (const entry of listed) {
    let bytes
    try {
      bytes = readFileSync(path.join(root, entry))
    } catch (error) {
      assert.fail(`${entry}, which \`git ls-files\` lists, could not be read: ${error.code ?? error.message}`)
    }
    files.push({ path: entry, bytes })
  }
  assert.equal(files.length, listed.length, 'the number of files read is not the number `git ls-files` lists')
  const found = pathsWithUnscopedForm(files)
  assert.deepEqual(found, [], `cite the scoped form \`${scopedForm}\` in ${found.join(', ')}`)
})

test('the form check reports a buffer in the unscoped form and not one in the scoped form', () => {
  // Planted from other fragments than the searched string, so the check is
  // held to the bytes and not only to its own constant.
  const planted = { path: 'planted', bytes: Buffer.from('npx ' + 'aim-arp telemetry opt-out') }
  const scoped = { path: 'scoped', bytes: Buffer.from('npx @opena2a/aim-sdk telemetry opt-out') }
  assert.deepEqual(pathsWithUnscopedForm([planted]), ['planted'], 'a buffer in the unscoped form is not reported')
  assert.deepEqual(pathsWithUnscopedForm([scoped]), [], 'a buffer in the scoped form is reported')
  assert.deepEqual(pathsWithUnscopedForm([planted, scoped]), ['planted'])
})
