// Guards the README's first screen: a visitor sees a command they can paste and
// the output it prints, before scrolling and before any caveat.
//
// The sample output is not trusted as written. The test runs the documented
// commands against the BUILT output and compares what they print with the
// README, so the sample cannot drift from what the package does.
//
// The commands are README text, so they are never evaluated inside the test
// process. They run the way a reader runs them: pasted into bash, in its own
// process, in a directory where `require('arp-guard')` resolves to this
// repository's build. They get PATH and nothing else from the runner's
// environment, and a time limit, so a script that never exits fails the test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n')

const INSTALL = 'npm install arp-guard'

// Line numbers here are 1-based, as an editor shows them.
function fencedBlocks(lines) {
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

// The `## ` headings outside fenced code blocks. A `## ` line inside a code
// sample is a comment or an example, not a section.
function sections(lines) {
  const fenced = new Set()
  for (const block of fencedBlocks(lines)) {
    for (let n = block.start; n <= block.end; n++) fenced.add(n)
  }
  return lines.filter((line, i) => line.startsWith('## ') && !fenced.has(i + 1))
}

function quickStart(lines) {
  const blocks = fencedBlocks(lines)
  const index = blocks.findIndex((b) => b.lang === 'bash' && b.body.includes(INSTALL))
  assert.notEqual(index, -1, `no bash block runs \`${INSTALL}\``)
  const output = blocks[index + 1]
  assert.ok(output, 'the install block has no output block after it')
  assert.equal(output.lang, 'text', 'the block after the install command is not its output')
  return { command: blocks[index], output }
}

// The install block as a reader pastes it, minus the install line, whose effect
// the scratch directory in runAsDocumented provides.
function documentedCommands(command) {
  const commands = command.body.filter((line) => line !== INSTALL).join('\n')
  assert.ok(commands.trim().length > 0, `the install block runs nothing after \`${INSTALL}\``)
  return commands
}

// Runs `commands` with bash in a scratch directory whose `node_modules/arp-guard`
// is this repository, so the package resolves to `dist/index.js` exactly as an
// installed copy would. `node` on the child's PATH is the one running the tests.
// Returns the lines the commands printed to stdout; throws if they time out,
// exit non-zero or print to stderr.
function runAsDocumented(commands, { timeout = 30_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arp-guard-readme-'))
  try {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(root, join(dir, 'node_modules', 'arp-guard'), 'junction')
    const PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter)
    const run = spawnSync('bash', ['-c', commands], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    })
    if (run.error?.code === 'ETIMEDOUT') {
      throw new Error(`the documented commands did not exit within ${timeout} ms`)
    }
    if (run.error) throw run.error
    if (run.status !== 0) {
      throw new Error(`the documented commands exited ${run.status ?? run.signal}:\n${run.stderr}`)
    }
    // A reader sees stderr too: bash reports a failed expansion there and
    // carries on, so stderr output fails the run even when the exit status is 0.
    if (run.stderr !== '') {
      throw new Error(`the documented commands exited 0 but printed to stderr:\n${run.stderr}`)
    }
    return run.stdout.replace(/\n$/, '').split('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a runnable command and its output end before line 30', () => {
  const { command, output } = quickStart(readme)
  assert.ok(command.start < 30, `the install command block starts at line ${command.start}`)
  assert.ok(output.end < 30, `its output block ends at line ${output.end}`)
})

test('Quick Start is the first section and the caveat section follows it', () => {
  const [first, second] = sections(readme)
  assert.equal(first, '## Quick Start')
  assert.equal(second, '## What `npm install` delivers today')
})

test('a `## ` line inside a code block is not a section', () => {
  const lines = ['## Quick Start', '```bash', '## comment', '```', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('the documented script runs in its own process against the built package', () => {
  const [pid, resolved] = runAsDocumented(
    `node -e "console.log(process.pid); console.log(require.resolve('arp-guard'))"`,
  )
  assert.ok(Number(pid) > 0, 'the script did not print a process id')
  assert.notEqual(Number(pid), process.pid, 'the script ran inside the test process')
  assert.equal(resolved, join(root, 'dist', 'index.js'))
})

test('the documented commands get PATH and no other variable from the runner', () => {
  const name = 'ARP_GUARD_README_TEST_PROBE'
  process.env[name] = 'visible'
  try {
    const [probe, path] = runAsDocumented(
      `node -e "console.log(process.env.${name} ?? 'unset'); console.log(process.env.PATH)"`,
    )
    assert.equal(probe, 'unset', 'a variable of the test runner reached the documented script')
    assert.ok(path.split(delimiter).includes(dirname(process.execPath)))
  } finally {
    delete process.env[name]
  }
})

test('documented commands that never exit fail instead of hanging', () => {
  assert.throws(
    () => runAsDocumented('node -e "setInterval(() => {}, 1000)"', { timeout: 1_000 }),
    /did not exit within 1000 ms/,
  )
})

test('documented commands that exit non-zero fail with their exit status', () => {
  assert.throws(() => runAsDocumented('echo probe-stderr >&2; exit 3'), {
    message: 'the documented commands exited 3:\nprobe-stderr\n',
  })
})

test('documented commands that exit 0 and print to stderr fail with a stderr message', () => {
  assert.throws(() => runAsDocumented('echo probe-stderr >&2'), {
    message: 'the documented commands exited 0 but printed to stderr:\nprobe-stderr\n',
  })
})

test('the documented commands run through bash, so shell expansion applies', () => {
  const lines = [
    '```bash',
    INSTALL,
    'node -e "',
    "const m = { pattern: { id: 'PI-001' } };",
    'console.log(`${m.pattern.id}`);',
    '"',
    '```',
    '',
    '```text',
    'PI-001',
    '```',
  ]
  const { command } = quickStart(lines)
  assert.throws(() => runAsDocumented(documentedCommands(command)), /bad substitution/)
})

test('the documented output is what the documented commands print', () => {
  const { command, output } = quickStart(readme)

  const printed = runAsDocumented(documentedCommands(command))

  assert.ok(printed.join('').length > 0, 'the documented commands printed nothing')
  assert.deepEqual(printed, output.body)
})
