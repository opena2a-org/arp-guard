// Guards the 0.4.0 section of CHANGELOG.md against the dependencies of the
// release before it. The published 0.3.0 depends on `hackmyagent`, the scanner,
// and loads the engine from `hackmyagent/arp`; 0.4.0 depends on the engine,
// `@opena2a/aim-sdk`, at the version package.json pins. Before this test, no
// entry of the section's Changed list gave `hackmyagent` with its 0.3.0 range,
// so the section did not list that change of dependency among the changes of
// 0.4.0.
//
// DEPENDENCIES_030 is what `npm view arp-guard@0.3.0 dependencies` printed on
// 2026-11-20, and a version on npm does not change. The dependencies of 0.4.0
// are read from package.json while its version is 0.4.0, the tree a tag push
// publishes as 0.4.0, so a change of the pin before then fails here until the
// entry gives the new version. Once package.json names a later version, it
// describes that release, not 0.4.0, and that check is skipped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const rootPackage = JSON.parse(read('package.json'))
const changelog = read('CHANGELOG.md').split('\n')

const RELEASE = '0.4.0'
const DEPENDENCIES_030 = { hackmyagent: '>=0.11.0' }

// A line that opens or closes a code block: three or more backticks or tildes,
// indented at most three spaces.
const FENCE = /^ {0,3}(`{3,}|~{3,})/

// The lines under the `heading` line of `lines`, up to the next heading of its
// level or a higher one outside a code block.
function under(lines, heading) {
  const level = /^#+/.exec(heading)[0].length
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `no ${heading} heading`)
  let fenced = false
  for (let i = start + 1; i < lines.length; i++) {
    const marks = /^(#+) /.exec(lines[i])
    if (FENCE.test(lines[i])) fenced = !fenced
    else if (!fenced && marks && marks[1].length <= level) return lines.slice(start + 1, i)
  }
  return lines.slice(start + 1)
}

// The items of the list in `lines`, each with the lines that continue it, as
// one text in which each run of whitespace is one space. An item starts with
// `- `, `* ` or `+ ` at the margin and runs up to the next one, or up to a line
// at the margin after a blank line, which starts a paragraph after the list.
function entries(lines) {
  const items = []
  let open = null
  let blank = false
  for (const line of lines) {
    if (/^[-*+] /.test(line)) items.push((open = [line]))
    else if (blank && /^\S/.test(line)) open = null
    else if (open && line.trim() !== '') open.push(line)
    blank = line.trim() === ''
  }
  return items.map((item) => item.join(' ').replace(/\s+/g, ' '))
}

// Whether `entry` names the package `name` in a code span and gives `version`
// as a version of its own, not as part of a longer one such as 1.3.10 or
// 11.3.1 for 1.3.1.
function gives(entry, name, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return entry.includes(`\`${name}\``) && new RegExp(`(?<![\\w.])${escaped}(?![\\w-]|\\.\\d)`).test(entry)
}

test('the lines under a heading run up to the next heading of its level or a higher one outside a code block', () => {
  const lines = ['# Changelog', '## 0.4.0', '### Added', '- a', '### Changed', '- b', '```', '## in a code block', '```', '- c', '## 0.3.0', '### Changed', '- d']
  assert.deepEqual(under(under(lines, '## 0.4.0'), '### Changed'), ['- b', '```', '## in a code block', '```', '- c'])
})

test('an entry runs up to the next one or up to a paragraph after the list', () => {
  const lines = ['- first', '  wrapped', '- second', '', '  more of second', '', 'After the list.']
  assert.deepEqual(entries(lines), ['- first wrapped', '- second more of second'])
})

test('a version is read only as a version of its own, and a package name only in a code span', () => {
  const entry = 'The package depends on `@opena2a/aim-sdk`, pinned at 1.3.1, in place of `hackmyagent` (`>=0.11.0`).'
  assert.ok(gives(entry, '@opena2a/aim-sdk', '1.3.1'), 'the pinned version is not read')
  assert.ok(gives(entry, 'hackmyagent', '>=0.11.0'), 'the range is not read')
  for (const other of ['1.3.10', '11.3.1', '1.3.1-beta.1', '1.3.1.2', 'v1.3.1']) {
    assert.ok(!gives(entry.replace('1.3.1', other), '@opena2a/aim-sdk', '1.3.1'), `1.3.1 is read in ${other}`)
  }
  assert.ok(!gives(entry.replace('`@opena2a/aim-sdk`', '@opena2a/aim-sdk'), '@opena2a/aim-sdk', '1.3.1'), 'a name outside a code span is read')
})

test('an entry of the Changed list of 0.4.0 gives the dependencies of 0.4.0 in place of those of the published 0.3.0', (t) => {
  if (rootPackage.version !== RELEASE) {
    t.skip(`package.json names ${rootPackage.version}, so its dependencies are not those of ${RELEASE}`)
    return
  }
  const dependencies = rootPackage.dependencies ?? {}
  const names = [...new Set([...Object.keys(DEPENDENCIES_030), ...Object.keys(dependencies)])]
  const required = names
    .filter((name) => DEPENDENCIES_030[name] !== dependencies[name])
    .flatMap((name) => [
      ...(Object.hasOwn(DEPENDENCIES_030, name) ? [[name, DEPENDENCIES_030[name]]] : []),
      ...(Object.hasOwn(dependencies, name) ? [[name, dependencies[name]]] : []),
    ])
  if (required.length === 0) return
  const changed = entries(under(under(changelog, `## ${RELEASE}`), '### Changed'))
  assert.ok(
    changed.some((entry) => required.every(([name, version]) => gives(entry, name, version))),
    `no entry of the Changed list of ${RELEASE} gives ${required.map(([name, version]) => `\`${name}\` ${version}`).join(', ')}`,
  )
})
