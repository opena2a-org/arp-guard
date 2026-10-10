// Guards the README's first screen: a visitor sees a command they can paste and
// the output it prints, before scrolling and before any caveat.
//
// The sample output is not trusted as written. The test runs the documented
// commands against the BUILT output and compares what they print with the
// README, so the sample cannot drift from what the package does.
//
// The commands are README text, so they are never evaluated inside the test
// process: run-as-documented.mjs runs them the way a reader runs them, and
// describes how.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { root, runAsDocumented } from './run-as-documented.mjs'

const readme = readFileSync(join(root, 'README.md'), 'utf8').split('\n')

const INSTALL = 'npm install arp-guard'

// A code fence, as CommonMark defines it: three or more backticks or tildes,
// indented at most three spaces. With the `s` flag `.*` also takes a carriage
// return or other line terminator left in the line, so `$` matches at once;
// without it a long fence run followed by one backtracks quadratically.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s

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

test('a fence indented up to three spaces opens a code block, and four spaces do not', () => {
  const lines = ['## Quick Start', '   ```', '## comment', '```', '    ```', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('a backtick after a ``` fence makes the line inline code, while a ~~~ fence allows one', () => {
  const lines = ['## Quick Start', '```a`b', '~~~a`b', '## comment', '~~~', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('a fence with text after it does not close a code block', () => {
  const lines = ['## Quick Start', '```', '``` y', '## comment', '```', '## Next']
  assert.deepEqual(sections(lines), ['## Quick Start', '## Next'])
})

test('a long fence run that ends in a carriage return is read in linear time', () => {
  const run = '`'.repeat(200_000)
  const started = Date.now()
  const blocks = fencedBlocks([`${run}\r`, 'x', run])
  const elapsed = Date.now() - started
  assert.deepEqual(
    blocks.map(({ start, end }) => [start, end]),
    [[1, 3]],
  )
  assert.ok(elapsed < 1_000, `reading the fences took ${elapsed} ms`)
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

// Resolves to the process id `file` records once it records one, or 0 if it
// records none within `within` ms.
async function recordedPid(file, within) {
  const deadline = Date.now() + within
  for (;;) {
    const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
    if (pid > 0 || Date.now() >= deadline) return pid
    await sleep(50)
  }
}

// A node -e script that records its process id in `pidFile` and never exits.
function neverExits(pidFile) {
  return `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
}

test('a never-exiting command that is not the last one stops with the run', async () => {
  // bash forks every command of the block but the last, so this node process is
  // a child of bash, not bash itself, and it outlives bash if only bash is stopped.
  const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
  const pidFile = join(scratch, 'pid')
  let stillRuns = 0
  try {
    await assert.rejects(
      runAsDocumented(`node -e '${neverExits(pidFile)}'\necho done`, { timeout: 3_000 }),
      /did not exit within 3000 ms/,
    )
    assert.ok(existsSync(pidFile), 'the never-exiting command did not start before the time limit')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(pid > 0, 'the never-exiting command did not record its process id')
    // Only a process seen running is stopped: once it has exited, its id can
    // belong to an unrelated process.
    if (!(await exits(pid, 5_000))) stillRuns = pid
    assert.equal(stillRuns, 0, `process ${pid}, started by the documented commands, still runs`)
  } finally {
    if (stillRuns > 0) {
      try {
        process.kill(stillRuns, 'SIGKILL')
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true })
  }
})

// Documented commands that start a process in a session of its own, which
// inherits stdout and stderr and never exits, then print `done`. The time limit
// does not stop that process, so `t.after` does, also when the test is
// cancelled at its own timeout. With `unref` the node process that starts it
// exits at once, and bash with it; otherwise node waits for it, and bash for node.
function startsProcessOutsideTheGroup(t, { unref }) {
  const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
  const pidFile = join(scratch, 'pid')
  t.after(async () => {
    const pid = await recordedPid(pidFile, 0)
    if (pid > 0 && !(await exits(pid, 0))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true })
  })
  const start = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(neverExits(pidFile))}], { detached: true, stdio: "inherit" })${unref ? '.unref()' : ''}`
  return `node -e '${start}'\necho done`
}

test('a run ends at the time limit while a process outside its group holds stdout', { timeout: 10_000 }, async (t) => {
  await assert.rejects(
    runAsDocumented(startsProcessOutsideTheGroup(t, { unref: false }), { timeout: 2_000 }),
    /did not exit within 2000 ms/,
  )
})

test('a run whose commands exited while a process they started holds stdout says so', { timeout: 10_000 }, async (t) => {
  await assert.rejects(runAsDocumented(startsProcessOutsideTheGroup(t, { unref: true }), { timeout: 2_000 }), {
    message:
      'the documented commands exited, but a process they started still held stdout or stderr open after 2000 ms',
  })
})

// Starts a node process that runs `commands` through the module at `helper`,
// as the test process does. Its stderr is kept: a runner that fails to start
// says why there and nowhere else.
function startRunner(helper, commands) {
  const script = `import { runAsDocumented } from ${JSON.stringify(helper)}\nawait runAsDocumented(${JSON.stringify(commands)}, { timeout: 60_000 })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
  // 'close' waits for stderr to close, so `stderr` is complete once this resolves.
  const ended = new Promise((resolve) => child.on('close', (status, received) => resolve(received ?? status)))
  return { child, ended, stderr: () => stderr }
}

// Resolves to the process id `pidFile` records. Fails, with the runner's
// stderr, as soon as the runner ends without one, or after `within` ms.
async function documentedPid(runner, pidFile, within) {
  let status = null
  runner.ended.then((received) => (status = received))
  const deadline = Date.now() + within
  for (;;) {
    const pid = await recordedPid(pidFile, 0)
    if (pid > 0) return pid
    if (status !== null || Date.now() >= deadline) break
    await sleep(50)
  }
  const reason = status === null ? `within ${within} ms` : `before the runner exited ${status}`
  assert.fail(`the documented command did not record its process id ${reason}; the runner's stderr:\n${runner.stderr()}`)
}

test('a runner that fails to start fails at once and shows its stderr', { timeout: 5_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
  const pidFile = join(scratch, 'pid')
  const runner = startRunner(new URL('./no-such-module.mjs', import.meta.url).href, `node -e '${neverExits(pidFile)}'`)
  try {
    await assert.rejects(
      documentedPid(runner, pidFile, 10_000),
      /did not record its process id before the runner exited 1; the runner's stderr:\n[\s\S]*Cannot find module/,
    )
  } finally {
    runner.child.kill('SIGKILL')
    rmSync(scratch, { recursive: true, force: true })
  }
})

// Whether process `pid` leads a process group. A group has the id of the
// process that leads it, and signal 0 only asks whether that group exists.
function leadsGroup(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

// The documented commands lead a session and process group of their own,
// outside the terminal's foreground group, so a Ctrl-C at the terminal, or the
// SIGHUP sent when the terminal closes, reaches only the test process. It stops
// them before it ends.
//
// The never-exiting command is not the last one, so bash forks it instead of
// replacing itself with it. As a child of bash it stops only if the whole
// group is stopped; as the group leader it would also stop if bash alone were.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`a ${signal} to the test process stops the documented commands it is running`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
    const pidFile = join(scratch, 'pid')
    const helper = new URL('./run-as-documented.mjs', import.meta.url).href
    const runner = startRunner(helper, `node -e '${neverExits(pidFile)}'\necho done`)
    let stillRuns = 0
    try {
      const pid = await documentedPid(runner, pidFile, 10_000)
      // Asked while it runs, asserted last: a failure before the signal is
      // sent would leave it running.
      const ledGroup = leadsGroup(pid)
      runner.child.kill(signal)
      // The message is built after `ended` resolves, so it holds all of stderr.
      assert.equal(await runner.ended, signal, `the test process did not end on ${signal}; its stderr:\n${runner.stderr()}`)
      if (!(await exits(pid, 5_000))) stillRuns = pid
      assert.equal(stillRuns, 0, `process ${pid}, started by the documented commands, still runs`)
      assert.ok(!ledGroup, `process ${pid} led the process group, so its stopping does not show the group was stopped`)
    } finally {
      if (stillRuns > 0) {
        try {
          process.kill(stillRuns, 'SIGKILL')
        } catch {}
      }
      runner.child.kill('SIGKILL')
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

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
