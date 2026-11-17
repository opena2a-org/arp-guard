// Guards step 2 of docs/testing/release-smoke.md, "The README's first command".
//
// The step writes a script, readme-first.js, that reads the README of the
// installed package, runs the README's first command without its install line
// and compares what that prints with the output block the README shows after
// it. Before, the script took the first bash block after the `## Quick Start`
// heading. Once the README gave its first command above that heading, that
// block was the example under Runtime monitoring: the script named `node -e "`
// as the install line and passed the eleven lines after it to the shell.
//
// So the step is run here as the page writes it: over the README and the build
// of this repository, and over READMEs that put the command elsewhere. What
// the page says of where the command stands is compared with the README.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { root } from './run-as-documented.mjs'

const page = readFileSync(join(root, 'docs', 'testing', 'release-smoke.md'), 'utf8').split('\n')
const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n')

// The line of the README's first command that the step leaves out: it installs
// the release on npm, and §1 of the page installs the packed packages.
const INSTALL = 'npm install arp-guard'

// A code fence, as CommonMark defines it: three or more backticks or tildes,
// indented at most three spaces.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s

// The fenced code blocks of `lines`, in order: the language of each and the
// lines between its fences. Only a fence of the opening character, at least as
// long and with nothing after it, closes a block.
function fencedBlocks(lines) {
  const blocks = []
  let open = null
  for (const line of lines) {
    const fence = FENCE.exec(line)
    if (open === null) {
      // A backtick in the info string makes the line inline code, not a fence.
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) open = { fence: fence[1], lang: fence[2].trim(), body: [] }
    } else if (fence && fence[1][0] === open.fence[0] && fence[1].length >= open.fence.length && fence[2].trim() === '') {
      blocks.push({ lang: open.lang, body: open.body })
      open = null
    } else {
      open.body.push(line)
    }
  }
  assert.equal(open, null, `a ${open?.fence} fence is never closed`)
  return blocks
}

// The step: the bash block of the page that runs readme-first.js, as the text
// a maintainer pastes, and the lines of the text block after it, which the
// page shows as what the step prints.
function firstCommandStep() {
  const blocks = fencedBlocks(page)
  const index = blocks.findIndex((block) => block.lang === 'bash' && block.body.includes('node readme-first.js'))
  assert.notEqual(index, -1, 'no bash block of the page runs `node readme-first.js`')
  const shown = blocks[index + 1]
  assert.equal(shown?.lang, 'text', 'the block after the step is not its output')
  return { commands: blocks[index].body.join('\n'), shown: shown.body }
}

const step = firstCommandStep()

// Runs the step with bash, as the page writes it, in a scratch project, and
// gives its exit status, what it printed and the names it left in the project.
// `install` fills the project's node_modules, in place of §1 of the page. The
// step gets PATH and nothing else from the runner's environment, and `node` on
// that PATH is the one running the tests. First on it is a stand-in for npm
// that prints its arguments to standard error and exits 1: the READMEs the
// step reads here hold install lines, and the last test passes an `npm` line
// to the shell to show that it runs the stand-in.
function runStep(install) {
  const dir = mkdtempSync(join(tmpdir(), 'arp-guard-release-smoke-'))
  try {
    const bin = join(dir, 'bin')
    const modules = join(dir, 'node_modules')
    mkdirSync(bin)
    mkdirSync(modules)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "the step ran npm $*" >&2\nexit 1\n', { mode: 0o755 })
    install(modules)
    const PATH = [bin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter)
    const run = spawnSync('bash', ['-c', step.commands], { cwd: dir, encoding: 'utf8', env: { PATH }, timeout: 60_000 })
    assert.ok(!run.error, `the step did not run to its end: ${run.error}`)
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, left: readdirSync(dir).sort() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Stands in for the project §1 of the page leaves, as far as the step reads
// it: `agent-runtime-protection` is this repository, so the step reads its
// README and runs its build, and `arp-guard` is a copy of the shim's
// package.json and entry point, as in run-as-documented.mjs.
function thisRepository(modules) {
  symlinkSync(root, join(modules, 'agent-runtime-protection'), 'junction')
  const shim = join(modules, 'arp-guard')
  mkdirSync(shim)
  for (const file of ['package.json', 'index.js']) copyFileSync(join(root, 'shim', 'arp-guard', file), join(shim, file))
}

// A project whose `agent-runtime-protection` holds a README of `lines` and no
// other file.
const readmeOf = (lines) => (modules) => {
  mkdirSync(join(modules, 'agent-runtime-protection'))
  writeFileSync(join(modules, 'agent-runtime-protection', 'README.md'), `${lines.join('\n')}\n`)
}

// The lines of a bash block that runs `commands`, and of a text block with
// `output` after it.
const example = (commands, output) => ['```bash', ...commands, '```', '', '```text', ...output, '```', '']

test('over the README and the build of this repository, the step prints what the page shows', () => {
  const run = runStep(thisRepository)
  assert.equal(run.status, 0, `the step exited ${run.status}:\n${run.stderr}`)
  assert.deepEqual(run.stdout.replace(/\n$/, '').split('\n'), step.shown)
  assert.equal(run.stderr, `(in place of: ${INSTALL})\n`)
  assert.equal(step.shown.at(-1), 'prints what the README shows')
})

// The page says where in the README the command stands. The sentence is read
// from the page and the README is checked against it: its first code block,
// the lines of that block, and the block after it.
test("the page says that the README's first code block is the command and the block after it its output, as the README has them", () => {
  const said =
    'The first code block of the [README](../../README.md) installs `arp-guard` and runs one `node -e` script, and the block after it shows what the script prints.'
  assert.ok(page.join('\n').replace(/\s+/g, ' ').includes(said), `the page does not say: ${said}`)

  const [first, second] = fencedBlocks(readme)
  assert.equal(first.lang, 'bash', "the README's first code block is not a bash block")
  assert.ok(first.body.includes(INSTALL), `the README's first code block does not run \`${INSTALL}\``)
  assert.equal(first.body.filter((line) => line.startsWith('node -e ')).length, 1, "the README's first code block does not run one `node -e` script")
  assert.equal(second.lang, 'text', "the block after the README's first code block is not a text block")
})

// Blocks that need no package. The commands of the first leave a file named
// `ran` in the project and print `scanned`; the other bash block prints
// `monitored`. Both have their output block after them.
const COMMANDS = ['touch ran', 'echo scanned']
const SCANS = example([INSTALL, ...COMMANDS], ['scanned'])
const MONITORS = example(['echo monitored'], ['monitored'])

const PLACES = [
  ['above the first `## ` heading, with another bash block under that heading', ['# Title', '', ...SCANS, '## Quick Start', '', ...MONITORS]],
  ['under a `## ` heading, after another bash block', ['# Title', '', ...MONITORS, '## Quick Start', '', ...SCANS]],
  ['with the install line as its last line', ['# Title', '', ...example([...COMMANDS, INSTALL], ['scanned'])]],
]

for (const [place, lines] of PLACES) {
  test(`the step runs the block that holds the install line: ${place}`, () => {
    const run = runStep(readmeOf(lines))
    assert.equal(run.status, 0, `the step exited ${run.status}:\n${run.stderr}`)
    assert.equal(run.stdout, 'scanned\nprints what the README shows\n')
    assert.equal(run.stderr, `(in place of: ${INSTALL})\n`)
    assert.deepEqual(run.left, ['bin', 'node_modules', 'ran', 'readme-first.js'])
  })
}

// READMEs with no block for the step to run: the same commands in a block
// that installs under another name, and in an install block whose next code
// block is not its output.
const NO_COMMAND = [
  ['whose bash block installs under another name', ['# Title', '', ...example(['npm install agent-runtime-protection', ...COMMANDS], ['scanned'])]],
  ['whose install block has another bash block, not a text block, as the next code block', ['# Title', '', '```bash', INSTALL, ...COMMANDS, '```', '', ...MONITORS]],
]

for (const [which, lines] of NO_COMMAND) {
  test(`the step stops, and runs no block, over a README ${which}`, () => {
    const run = runStep(readmeOf(lines))
    assert.notEqual(run.status, 0, 'the step exited 0')
    assert.match(run.stderr, /no bash block of the README holds "npm install arp-guard" with a text block as the next code block/)
    assert.equal(run.stdout, '')
    assert.deepEqual(run.left, ['bin', 'node_modules', 'readme-first.js'])
  })
}

test('an npm line the step passes to the shell runs the stand-in, which fails the run', () => {
  const lines = ['# Title', '', ...example([INSTALL, 'npm --version'], ['0.0.0'])]
  const run = runStep(readmeOf(lines))
  assert.notEqual(run.status, 0, 'the step exited 0')
  assert.match(run.stderr, /^the step ran npm --version$/m)
  assert.equal(run.stdout, '')
})
