// Guards the account docs/install.md gives of the release on npm. The README's
// install line, `npm install arp-guard`, installs the published 0.3.0, not
// `main`, and the page's What `npm install` delivers today section, which the
// README links, is where a reader learns how the two differ.
//
// A new-user pass found the section giving two differences while the install
// brought more: the scanner and a model runtime whose `postinstall` script npm
// runs and then reports, executables in `node_modules/.bin`, and an export surface
// without the two consent functions `main` exports. The section lists each of
// them, and the count its first paragraph gives is the number of items in that
// list, so an item added or removed without the count fails here.
//
// The L2 default, which the section once counted as one of those items, is not
// a difference: a build of `main` has it too. The section gives it in a
// paragraph after the list, and an item of the list that gives it fails here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './run-as-documented.mjs'

const page = readFileSync(join(root, 'docs', 'install.md'), 'utf8').split('\n')
const HEADING = '## What `npm install` delivers today'

// A code fence, as CommonMark defines it: three or more backticks or tildes,
// indented at most three spaces.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s

// The count is written as a word, as the page's prose writes small numbers.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

// Each line with whether it is inside a fenced code block, fences included.
// Only a fence of the opening character, at least as long and with nothing
// after it, closes a block.
function withFences(lines) {
  let open = null
  const marked = lines.map((line) => {
    const fence = FENCE.exec(line)
    if (open === null) {
      // A backtick in the info string makes the line inline code, not a fence.
      if (!fence || (fence[1][0] === '`' && fence[2].includes('`'))) return { line, fenced: false }
      open = fence[1]
      return { line, fenced: true }
    }
    if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && fence[2].trim() === '') open = null
    return { line, fenced: true }
  })
  assert.equal(open, null, `a ${open} fence is never closed`)
  return marked
}

// The lines under `heading`, up to the next `## ` heading outside a code block:
// all of them as one text, each run of whitespace read as one space so a phrase
// is found wherever the paragraph wraps, and the ones outside code blocks.
function section(lines, heading) {
  const marked = withFences(lines)
  const isHeading = ({ line, fenced }) => line.startsWith('## ') && !fenced
  const start = marked.findIndex((entry) => entry.line === heading && isHeading(entry))
  assert.notEqual(start, -1, `docs/install.md has no ${heading} section`)
  const next = marked.findIndex((entry, i) => i > start && isHeading(entry))
  const body = marked.slice(start + 1, next === -1 ? marked.length : next)
  return {
    text: body.map(({ line }) => line).join('\n').replace(/\s+/g, ' '),
    prose: body.filter(({ fenced }) => !fenced).map(({ line }) => line),
  }
}

// The items of the lists in `prose` that start at the margin. An item nested
// under another is indented, and is part of the item it is nested under.
function topLevelItems(prose) {
  return prose.filter((line) => /^([-*+]|\d+[.)]) /.test(line))
}

// Each of those items as one text, with the lines that continue it: an item
// runs up to the next one, or up to a line at the margin after a blank line,
// which starts a paragraph after the list.
function itemTexts(prose) {
  const items = []
  let open = null
  let blank = false
  for (const line of prose) {
    if (/^([-*+]|\d+[.)]) /.test(line)) items.push((open = [line]))
    else if (blank && /^\S/.test(line)) open = null
    else if (open && line.trim() !== '') open.push(line)
    blank = line.trim() === ''
  }
  return items.map((lines) => lines.join(' ').replace(/\s+/g, ' '))
}

function sentences(prose) {
  return prose.join(' ').replace(/\s+/g, ' ').split(/(?<=[.!?]) (?=\S)/)
}

// Whether `sentence` says that 0.3.0 does not export the two consent functions:
// each name is in a list of code spans, joined by commas, `and` or `or`, right
// after `0.3.0 does not export` or `0.3.0 does not export include`. A `not`
// elsewhere in the sentence, such as the one in the page's "and not a library
// call", says nothing about the exports.
const NOT_EXPORTED = /\b0\.3\.0 does not export (?:include )?(`[^`]+`(?:(?:,? (?:and|or) |, )`[^`]+`)*)/g

function saysNotExported(sentence) {
  const lists = [...sentence.matchAll(NOT_EXPORTED)].map((match) => match[1])
  return ['writeOptOutMarker', 'clearOptOutMarker'].every((name) => lists.some((list) => list.includes(`\`${name}\``)))
}

const delivers = section(page, HEADING)

test('the items counted are the top-level list items outside code blocks', () => {
  const lines = ['## A', 'Text.', '', '- first', '  - nested', '* second', '1. third', '```text', '- in a code block', '```', '## B', '- other']
  const { prose } = section(lines, '## A')
  assert.deepEqual(topLevelItems(prose), ['- first', '* second', '1. third'])
})

test('an item runs up to the next item or up to a paragraph after the list', () => {
  const prose = ['Text.', '', '- first', 'wrapped', '  - nested', '', '  more of first', '* second', '', 'After the list.']
  assert.deepEqual(itemTexts(prose), ['- first wrapped - nested more of first', '* second'])
})

test('only names listed right after "0.3.0 does not export" are read as not exported', () => {
  const said =
    "The names 0.3.0 does not export include `writeOptOutMarker` and `clearOptOutMarker`, the engine's consent functions, so on 0.3.0 the telemetry opt-out is `npx aim-arp telemetry opt-out`, which writes the marker `writeOptOutMarker()` writes on `main`, and not a library call."
  assert.ok(saysNotExported(said), 'the page sentence is not read as saying that 0.3.0 does not export the functions')
  // Without its negation, the sentence still ends "and not a library call".
  const exported = said.replace('The names 0.3.0 does not export include', 'The names 0.3.0 exports include')
  assert.ok(!saysNotExported(exported), 'a sentence that says 0.3.0 exports the functions is read as saying it does not')
  const otherClause = 'The names 0.3.0 does not export include `canonicalize`, and its names include `writeOptOutMarker` and `clearOptOutMarker`.'
  assert.ok(!saysNotExported(otherClause), 'a negation in another clause is read as saying that 0.3.0 does not export the functions')
  const doubleNegation = 'The names 0.3.0 does not export do not include `writeOptOutMarker` and `clearOptOutMarker`.'
  assert.ok(!saysNotExported(doubleNegation), 'a second negation before the names is read as saying that 0.3.0 does not export them')
})

test('the section says that the install brings a model runtime with a postinstall script that npm reports', () => {
  for (const name of ['onnxruntime-node', 'postinstall', 'install-scripts']) {
    assert.ok(delivers.text.includes(name), `the section does not name ${name}`)
  }
})

test('the section names the executables the install places in node_modules/.bin', () => {
  for (const name of ['node_modules/.bin', 'aim-arp', 'hackmyagent']) {
    assert.ok(delivers.text.includes(name), `the section does not name ${name}`)
  }
})

test('the section says that the release does not export the two consent functions', () => {
  assert.ok(
    sentences(delivers.prose).some(saysNotExported),
    'no sentence of the section lists writeOptOutMarker and clearOptOutMarker right after "0.3.0 does not export"',
  )
})

test('the number of differences the section gives is the number of items in its list', () => {
  const count = /differs from `main` in (\S+) ways/.exec(delivers.text)
  assert.ok(count, 'the section does not say in how many ways the release differs from `main`')
  const said = NUMBER_WORDS.indexOf(count[1])
  assert.notEqual(said, -1, `the count "${count[1]}" is not written as a number word`)
  assert.equal(topLevelItems(delivers.prose).length, said, `the section says ${count[1]} ways and lists another number`)
})

// Run against the build: with no `intelligence` block in the config, the engine
// `main` pins chooses an adapter, which it does only while L2 is on.
test('the L2 default, which `main` has as well, is not an item of the list of differences', (t) => {
  const { AgentRuntimeProtection } = createRequire(import.meta.url)('../dist/index.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'arp-guard-install-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const arp = new AgentRuntimeProtection({ agentName: 'my-agent', dataDir })
  assert.ok(arp.getIntelligence().adapter, 'a build of `main` leaves L2 off with no `intelligence` block, so the L2 default is a way 0.3.0 differs from it')

  const listed = itemTexts(delivers.prose).filter((item) => /\bL2\b/.test(item))
  assert.deepEqual(listed, [], 'an item of the list gives the L2 default as a way 0.3.0 differs from `main`')
  const said = sentences(delivers.prose).find(
    (sentence) => /\bL2 default\b/.test(sentence) && /\bsame\b/.test(sentence) && sentence.includes('`main`'),
  )
  assert.ok(said, 'no sentence of the section says that the L2 default is the same on `main`')
})
