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
// environment, and a time limit, so a script that never exits fails the test
// and leaves no process behind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n')

const INSTALL = 'npm install arp-guard'

// A code fence, as CommonMark defines it: three or more backticks or tildes,
// indented at most three spaces.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// Line numbers here are 1-based, as an editor shows them. Only a fence of the
// opening character, at least as long and with nothing after it, closes a
// block, so a ``` line inside a ~~~ block is part of the block. A block that is
// never closed throws: it would otherwise hide every heading after it.
function fencedBlocks(lines) {
  const blocks = []
  let open = null
  lines.forEach((line, i) => {
    const fence = FENCE.exec(line)
    if (!fence) return
    const [, run, rest] = fence
    if (open === null) {
      // A backtick in the info string makes the line inline code, not a fence.
      if (run[0] === '`' && rest.includes('`')) return
      open = { fence: run, lang: rest.trim(), start: i + 1 }
    } else if (run[0] === open.fence[0] && run.length >= open.fence.length && rest.trim() === '') {
      blocks.push({ lang: open.lang, start: open.start, end: i + 1 })
      open = null
    }
  })
  if (open !== null) {
    throw new Error(`the ${open.fence} fence opened at line ${open.start} is never closed`)
  }
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
// Resolves to the lines the commands printed to stdout; rejects if they time
// out, exit non-zero or print to stderr.
//
// bash forks every command of the block but the last, so a command that never
// exits can be a child of bash rather than bash itself. bash therefore leads its
// own process group, and the time limit stops the whole group, not only bash.
async function runAsDocumented(commands, { timeout = 30_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arp-guard-readme-'))
  try {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(root, join(dir, 'node_modules', 'arp-guard'), 'junction')
    const PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter)
    const run = await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', commands], {
        cwd: dir,
        detached: true,
        env: { PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = { stdout: '', stderr: '', timedOut: false }
      child.stdout.setEncoding('utf8').on('data', (chunk) => (output.stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk) => (output.stderr += chunk))
      const timer = setTimeout(() => {
        output.timedOut = true
        try {
          // SIGKILL, so a command that handles SIGTERM cannot keep running.
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          // ESRCH: every process of the group has already exited.
          if (error.code !== 'ESRCH') reject(error)
        }
        // A process that left the group can still hold the pipes open; stop
        // reading so the run ends once bash has exited.
        child.stdout.destroy()
        child.stderr.destroy()
      }, timeout)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        resolve({ ...output, status, signal })
      })
    })
    if (run.timedOut) {
      throw new Error(`the documented commands did not exit within ${timeout} ms`)
    }
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

test('a `## ` line inside a tilde code block is not a section', () => {
  const lines = ['## Quick Start', '~~~', '## comment', '~~~', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('a code block closes only on a fence of its own character, at least as long', () => {
  const lines = ['## Quick Start', '~~~~markdown', '```', '~~~', '## comment', '~~~~', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('an unclosed code block fails the check instead of hiding the sections after it', () => {
  const lines = ['## Quick Start', '```bash', '## comment', '## Next']
  assert.throws(() => sections(lines), /``` fence opened at line 2 is never closed/)
})

test('the documented script runs in its own process against the built package', async () => {
  const [pid, resolved] = await runAsDocumented(
    `node -e "console.log(process.pid); console.log(require.resolve('arp-guard'))"`,
  )
  assert.ok(Number(pid) > 0, 'the script did not print a process id')
  assert.notEqual(Number(pid), process.pid, 'the script ran inside the test process')
  assert.equal(resolved, join(root, 'dist', 'index.js'))
})

test('the documented commands get PATH and no other variable from the runner', async () => {
  const name = 'ARP_GUARD_README_TEST_PROBE'
  process.env[name] = 'visible'
  try {
    const [probe, path] = await runAsDocumented(
      `node -e "console.log(process.env.${name} ?? 'unset'); console.log(process.env.PATH)"`,
    )
    assert.equal(probe, 'unset', 'a variable of the test runner reached the documented script')
    assert.ok(path.split(delimiter).includes(dirname(process.execPath)))
  } finally {
    delete process.env[name]
  }
})

test('documented commands that never exit fail instead of hanging', async () => {
  await assert.rejects(
    runAsDocumented('node -e "setInterval(() => {}, 1000)"', { timeout: 1_000 }),
    /did not exit within 1000 ms/,
  )
})

test('documented commands that exit non-zero fail with their exit status', async () => {
  await assert.rejects(runAsDocumented('echo probe-stderr >&2; exit 3'), {
    message: 'the documented commands exited 3:\nprobe-stderr\n',
  })
})

test('documented commands that exit 0 and print to stderr fail with a stderr message', async () => {
  await assert.rejects(runAsDocumented('echo probe-stderr >&2'), {
    message: 'the documented commands exited 0 but printed to stderr:\nprobe-stderr\n',
  })
})

// Resolves to true once no process `pid` exists, or false if it still runs
// after `within` ms.
async function exits(pid, within) {
  const deadline = Date.now() + within
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return true
      throw error
    }
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
}

test('a never-exiting command that is not the last one stops with the run', async () => {
  // bash forks every command of the block but the last, so this node process is
  // a child of bash, not bash itself, and it outlives bash if only bash is stopped.
  const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
  const pidFile = join(scratch, 'pid')
  let pid = 0
  try {
    await assert.rejects(
      runAsDocumented(
        `node -e 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)'\necho done`,
        { timeout: 3_000 },
      ),
      /did not exit within 3000 ms/,
    )
    assert.ok(existsSync(pidFile), 'the never-exiting command did not start before the time limit')
    pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(pid > 0, 'the never-exiting command did not record its process id')
    assert.ok(await exits(pid, 5_000), `process ${pid}, started by the documented commands, still runs`)
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the documented commands run through bash, so shell expansion applies', async () => {
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
  await assert.rejects(runAsDocumented(documentedCommands(command)), /bad substitution/)
})

test('the documented output is what the documented commands print', async () => {
  const { command, output } = quickStart(readme)

  const printed = await runAsDocumented(documentedCommands(command))

  assert.ok(printed.join('').length > 0, 'the documented commands printed nothing')
  assert.deepEqual(printed, output.body)
})
