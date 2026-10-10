// Guards the README's first screen: a visitor sees a command they can paste and
// the output it prints, before scrolling and before any caveat.
//
// The sample output is not trusted as written. The test runs the documented
// command's script against the BUILT output and compares what it prints with
// the README, so the sample cannot drift from what the package does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { format } from 'node:util'

const require = createRequire(import.meta.url)
const lines = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n')

// Line numbers here are 1-based, as an editor shows them.
function fencedBlocks() {
  const blocks = []
  let open = null
  lines.forEach((line, i) => {
    if (!line.startsWith('```')) return
    if (open === null) {
      open = { lang: line.slice(3).trim(), start: i + 1, body: [] }
    } else {
      blocks.push({ ...open, end: i + 1 })
      open = null
    }
  })
  for (const block of blocks) block.body = lines.slice(block.start, block.end - 1)
  return blocks
}

function quickStart() {
  const blocks = fencedBlocks()
  const index = blocks.findIndex(
    (b) => b.lang === 'bash' && b.body.includes('npm install arp-guard'),
  )
  assert.notEqual(index, -1, 'no bash block runs `npm install arp-guard`')
  const output = blocks[index + 1]
  assert.ok(output, 'the install block has no output block after it')
  assert.equal(output.lang, 'text', 'the block after the install command is not its output')
  return { command: blocks[index], output }
}

test('a runnable command and its output end before line 30', () => {
  const { command, output } = quickStart()
  assert.ok(command.start < 30, `the install command block starts at line ${command.start}`)
  assert.ok(output.end < 30, `its output block ends at line ${output.end}`)
})

test('Quick Start is the first section and the caveat section follows it', () => {
  const sections = lines.filter((line) => line.startsWith('## '))
  assert.equal(sections[0], '## Quick Start')
  assert.equal(sections[1], '## What `npm install` delivers today')
})

test('the documented output is what the documented command prints', () => {
  const { command, output } = quickStart()
  const open = command.body.indexOf('node -e "')
  const close = command.body.indexOf('"', open + 1)
  assert.ok(open !== -1 && close > open, 'no `node -e "..."` script in the install block')
  const script = command.body.slice(open + 1, close).join('\n')

  const printed = []
  const capture = { log: (...args) => printed.push(format(...args)) }
  const resolve = (name) => {
    assert.equal(name, 'arp-guard', `the script requires ${name}`)
    return require('../dist/index.js')
  }
  new Function('require', 'console', script)(resolve, capture)

  assert.ok(printed.length > 0, 'the documented script printed nothing')
  assert.deepEqual(printed, output.body)
})
