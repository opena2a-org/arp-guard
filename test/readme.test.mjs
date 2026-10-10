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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

// Runs `body` with a new scratch directory, and removes the directory once
// `body` has ended, also when it throws. A `startRunner` call that throws does
// so before the `try` that stops the runner, so that `try` cannot remove it.
async function withScratch(body) {
  const scratch = mkdtempSync(join(tmpdir(), 'arp-guard-readme-pid-'))
  try {
    return await body(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// The name of every node:fs function that makes a temporary directory, alone or
// with a suffix: the synchronous one, the one that takes a callback and the one
// that returns a promise.
const MAKES_SCRATCH = /mkdtemp\w*/g

// A block or line comment. A block comment ends at the first `*/`, or at the
// end of the source when it is never closed. Without that end, each `import /*`
// line that is never closed would scan the rest of the source before failing,
// which takes quadratic time.
const COMMENT = String.raw`\/\*(?:[^*]|\*(?!\/))*(?:\*\/|(?![\s\S]))|\/\/[^\n]*`

// The names an `import` declaration binds, up to the module it names, with the
// comments that stand between them.
const IMPORT_CLAUSE = new RegExp(String.raw`^import\b(?:[\w$\s{},*]|${COMMENT})*`, 'gm')

// What follows a name that an `import` renames: `as`, after space or comments.
const RENAMED = new RegExp(String.raw`^(?:\s|${COMMENT})+as\b`)

// Where `source` names a function that makes a temporary directory: how often
// in `withScratch`, and the 1-based lines elsewhere. The name counts wherever
// it stands, so an alias, a property read and a `node -e` script count as a
// call does. Two places are not counted: the pattern above, which holds the
// name and uses nothing, and an `import` that binds the function under its own
// name, since every use of that binding is counted. An `import` that renames
// the function is counted, because the uses of the new name are not, and so is
// the name in a comment inside an `import`, which binds nothing.
function scratchSites(source) {
  const start = source.indexOf('\nasync function withScratch(')
  const end = source.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, 'withScratch was not found')
  const pattern = String(MAKES_SCRATCH)
  const clauses = [...source.matchAll(IMPORT_CLAUSE)].map(({ 0: text, index }) => ({
    from: index,
    to: index + text.length,
    comments: [...text.matchAll(new RegExp(COMMENT, 'g'))].map((c) => [index + c.index, index + c.index + c[0].length]),
  }))
  const sites = [...source.matchAll(MAKES_SCRATCH)]
    .filter(({ 0: name, index }) => {
      if (source.startsWith(pattern, index - 1)) return false
      const after = index + name.length
      const clause = clauses.find(({ from, to }) => index >= from && after <= to)
      if (!clause || clause.comments.some(([from, to]) => index >= from && index < to)) return true
      return RENAMED.test(source.slice(after, clause.to))
    })
    .map(({ index }) => index)
  const outside = sites.filter((index) => index < start || index > end)
  return {
    inside: sites.length - outside.length,
    outside: outside.map((index) => source.slice(0, index).split('\n').length),
  }
}

// Fails unless `source` names a function that makes a temporary directory in
// `withScratch` and nowhere else. The name counts in a comment or a string as
// well, so the message names the line, not a scratch directory made there.
function assertScratchOnlyInWithScratch(source) {
  const { inside, outside } = scratchSites(source)
  assert.equal(inside, 1, 'withScratch does not make its scratch directory')
  assert.deepEqual(outside, [], `outside withScratch, a temporary-directory function is named at line ${outside.join(', line ')}`)
}

// A scratch directory made anywhere but `withScratch` is removed only if
// nothing between its creation and its own cleanup throws.
test('the tests make their scratch directories only through withScratch', () => {
  assertScratchOnlyInWithScratch(readFileSync(new URL(import.meta.url), 'utf8'))
})

// This file with `added` as new lines above `neverExits`, where no scratch
// directory is made, and the 1-based number of the first of them.
function addedAboveNeverExits(added) {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const at = source.indexOf('\nfunction neverExits(')
  assert.ok(at >= 0, 'neverExits was not found')
  return { changed: `${source.slice(0, at)}\n${added}${source.slice(at)}`, line: source.slice(0, at).split('\n').length + 1 }
}

// This file with `added` as new lines at its end, and the 1-based number of the
// first of them. No `*/` follows there, so a block comment read on to the last
// `*/` instead of the first ends inside `added`, and the import clause that
// holds it takes in the names after it. Above `neverExits` it would run on to a
// `*/` further down and cover those names, which counts them either way.
function addedAtEnd(added) {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  return { changed: `${source}${added}\n`, line: source.split('\n').length }
}

// The names are read from `withScratch`, so these tests name no such function
// themselves and add nothing for the check above to count.
test('a scratch directory made under another name, or without the synchronous call, counts as made outside withScratch', () => {
  const [synchronous] = String(withScratch).match(MAKES_SCRATCH)
  const asynchronous = synchronous.replace(/Sync$/, '')
  for (const added of [
    `const make = ${synchronous}`,
    `const made = ${asynchronous}(join(tmpdir(), 'arp-guard-readme-pid-'), () => {})`,
    `const made = fs.promises.${asynchronous}(join(tmpdir(), 'arp-guard-readme-pid-'))`,
    `import { ${synchronous} as make } from 'node:fs'`,
    `import { ${synchronous} /* renamed */ as make } from 'node:fs'`,
    `import { ${synchronous} // renamed\n as make } from 'node:fs'`,
    `import { tmpdir /* ${synchronous} */ } from 'node:os'`,
    `import { tmpdir /* a */ } from 'node:os'\n/* b */ ${synchronous}(z)`,
  ]) {
    for (const { changed, line } of [addedAboveNeverExits(added), addedAtEnd(added)]) {
      // The line of `added` that names the function.
      const named = line + added.slice(0, added.search(MAKES_SCRATCH)).split('\n').length - 1
      assert.deepEqual(scratchSites(changed), { inside: 1, outside: [named] }, `not counted at line ${named}: ${added}`)
    }
  }
})

test('a comment that names a temporary-directory function fails the check with a message that says so', () => {
  const [synchronous] = String(withScratch).match(MAKES_SCRATCH)
  const { changed, line } = addedAboveNeverExits(`// ${synchronous}`)
  // The message's first line: node can add the difference after it.
  assert.throws(() => assertScratchOnlyInWithScratch(changed), {
    message: new RegExp(`^outside withScratch, a temporary-directory function is named at line ${line}$`, 'm'),
  })
})

test('import lines with a block comment that is never closed are read in linear time', () => {
  const source = 'import /*\n'.repeat(20_000)
  const started = Date.now()
  const clauses = [...source.matchAll(IMPORT_CLAUSE)]
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1_000, `reading the import clauses took ${elapsed} ms`)
  assert.deepEqual(
    clauses.map(({ 0: text, index }) => [index, text.length]),
    [[0, source.length]],
  )
})

test('a never-exiting command that is not the last one stops with the run', () =>
  withScratch(async (scratch) => {
    // bash forks every command of the block but the last, so this node process is
    // a child of bash, not bash itself, and it outlives bash if only bash is stopped.
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
    }
  }),
)

// Runs `body` with documented commands that start a process in a session of
// its own, which inherits stdout and stderr and never exits, then print `done`,
// and with the file where that process records its process id.
// With `unref` the node process that starts it exits at once, and bash with it;
// otherwise node waits for it, and bash for node. The time limit does not stop
// that process, so it is stopped once `body` has ended, before the scratch
// directory that holds its process id is removed, and by `t.after` when the
// test is cancelled at its own timeout while `body` still runs.
function withProcessOutsideTheGroup(t, { unref }, body) {
  return withScratch(async (scratch) => {
    const pidFile = join(scratch, 'pid')
    // Only a process seen running is stopped.
    const stop = async () => {
      const pid = await recordedPid(pidFile, 0)
      if (pid > 0 && !(await exits(pid, 0))) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
    t.after(stop)
    const start = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(neverExits(pidFile))}], { detached: true, stdio: "inherit" })${unref ? '.unref()' : ''}`
    try {
      return await body(`node -e '${start}'\necho done`, pidFile)
    } finally {
      await stop()
    }
  })
}

test('a run ends at the time limit while a process outside its group holds stdout', { timeout: 10_000 }, (t) =>
  withProcessOutsideTheGroup(t, { unref: false }, (commands) =>
    assert.rejects(runAsDocumented(commands, { timeout: 2_000 }), /did not exit within 2000 ms/),
  ),
)

test('a run whose commands exited while a process they started holds stdout says so', { timeout: 10_000 }, (t) =>
  withProcessOutsideTheGroup(t, { unref: true }, (commands) =>
    assert.rejects(runAsDocumented(commands, { timeout: 2_000 }), {
      message:
        'the documented commands exited, but a process they started still held stdout or stderr open after 2000 ms',
    }),
  ),
)

// Once withProcessOutsideTheGroup has returned, nothing else stops the process
// it started: `t.after` reads its id from the scratch directory, which is gone
// by then.
test('the process started outside the group has exited once the test using it has ended', { timeout: 15_000 }, async (t) => {
  let pid = 0
  let stillRuns = 0
  try {
    await withProcessOutsideTheGroup(t, { unref: true }, async (commands, pidFile) => {
      await assert.rejects(runAsDocumented(commands, { timeout: 2_000 }), /still held stdout or stderr open/)
      pid = await recordedPid(pidFile, 5_000)
    })
    assert.ok(pid > 0, 'the process outside the group did not record its process id')
    // Only a process seen running is stopped.
    if (!(await exits(pid, 5_000))) stillRuns = pid
    assert.equal(stillRuns, 0, `process ${pid}, started outside the group, still runs`)
  } finally {
    if (stillRuns > 0) {
      try {
        process.kill(stillRuns, 'SIGKILL')
      } catch {}
    }
  }
})

// A test cancelled at its own timeout runs its `t.after` cleanups while its
// body still runs, so the `finally` that stops the process has not run yet.
// Here the body waits until the cleanup has been run and the process checked.
test('the process started outside the group is stopped by t.after while the body still runs', { timeout: 15_000 }, async () => {
  const after = []
  let recorded
  const started = new Promise((resolve) => (recorded = resolve))
  let release
  const released = new Promise((resolve) => (release = resolve))
  let stillRuns = 0
  const using = withProcessOutsideTheGroup({ after: (cleanup) => after.push(cleanup) }, { unref: true }, async (commands, pidFile) => {
    const run = runAsDocumented(commands, { timeout: 2_000 }).catch((error) => error)
    recorded(await recordedPid(pidFile, 5_000))
    await released
    await run
  })
  try {
    // `using` settles first only if it fails before the body records the id.
    const pid = await Promise.race([started, using])
    assert.ok(pid > 0, 'the process outside the group did not record its process id')
    assert.equal(after.length, 1, 'withProcessOutsideTheGroup registered no t.after cleanup')
    await after[0]()
    // Only a process seen running is stopped.
    if (!(await exits(pid, 5_000))) stillRuns = pid
    assert.equal(stillRuns, 0, `process ${pid}, started outside the group, still runs after the t.after cleanup`)
  } finally {
    if (stillRuns > 0) {
      try {
        process.kill(stillRuns, 'SIGKILL')
      } catch {}
    }
    release()
    await using
  }
})

// Starts a node process that runs `commands` through the module at `helper`,
// as the test process does, with `tmp` as its temp dir, so the scratch
// directories it makes are the ones `scratchDirs(tmp)` lists. Its stderr is
// kept: a runner that fails to start says why there and nowhere else.
function startRunner(helper, commands, tmp) {
  // Without `tmp` the runner would start with no TMPDIR and make its scratch
  // directories in the system temp dir, where `scratchDirs(tmp)` does not look.
  assert.equal(typeof tmp, 'string', 'startRunner was not given the temp dir for the runner')
  const script = `import { runAsDocumented } from ${JSON.stringify(helper)}\nawait runAsDocumented(${JSON.stringify(commands)}, { timeout: 60_000 })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
  // 'close' waits for stderr to close, so `stderr` is complete once this resolves.
  const ended = new Promise((resolve) => child.on('close', (status, received) => resolve(received ?? status)))
  return { child, ended, stderr: () => stderr }
}

// The scratch directories runAsDocumented has made in `tmp` and not removed.
function scratchDirs(tmp) {
  return readdirSync(tmp).filter((name) => name.startsWith('arp-guard-readme-'))
}

// Stops `runner` unless it has ended. SIGTERM first: the runner's handler stops
// the process groups of the documented commands it runs. No process can handle
// a SIGKILL, so it would leave them running; it is sent only if the runner
// still runs after `within` ms.
async function stopRunner(runner, within = 5_000) {
  if (runner.child.exitCode !== null || runner.child.signalCode !== null) return
  runner.child.kill('SIGTERM')
  // Unreferenced, so a runner that ends at once does not hold this process
  // open for the rest of `within`.
  const limit = sleep(within, false, { ref: false })
  if (!(await Promise.race([runner.ended.then(() => true), limit]))) runner.child.kill('SIGKILL')
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

test('a runner that fails to start fails at once and shows its stderr', { timeout: 5_000 }, () =>
  withScratch(async (scratch) => {
    const pidFile = join(scratch, 'pid')
    const runner = startRunner(
      new URL('./no-such-module.mjs', import.meta.url).href,
      `node -e '${neverExits(pidFile)}'`,
      scratch,
    )
    try {
      await assert.rejects(
        documentedPid(runner, pidFile, 10_000),
        /did not record its process id before the runner exited 1; the runner's stderr:\n[\s\S]*Cannot find module/,
      )
    } finally {
      await stopRunner(runner)
    }
  }),
)

// The cleanup of a test whose `startRunner` call throws, here because it is
// given no temp dir for the runner.
test('a test whose runner cannot be started removes its scratch directory', async () => {
  const helper = new URL('./run-as-documented.mjs', import.meta.url).href
  let scratch
  let existed = false
  await assert.rejects(
    withScratch((dir) => {
      scratch = dir
      // Asked while the test would use it, asserted last.
      existed = existsSync(dir)
      startRunner(helper, 'echo done')
    }),
    /startRunner was not given the temp dir for the runner/,
  )
  assert.ok(existed, 'the test was given no scratch directory')
  assert.ok(!existsSync(scratch), `the scratch directory ${scratch} was left behind`)
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
// them, and removes the scratch directory they run in, before it ends.
//
// The never-exiting command is not the last one, so bash forks it instead of
// replacing itself with it. As a child of bash it stops only if the whole
// group is stopped; as the group leader it would also stop if bash alone were.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`a ${signal} to the test process stops the documented commands it is running`, () =>
    withScratch(async (scratch) => {
      const pidFile = join(scratch, 'pid')
      const helper = new URL('./run-as-documented.mjs', import.meta.url).href
      const runner = startRunner(helper, `node -e '${neverExits(pidFile)}'\necho done`, scratch)
      let stillRuns = 0
      try {
        const pid = await documentedPid(runner, pidFile, 10_000)
        // Asked while it runs, asserted last: a failure before the signal is
        // sent would leave it running.
        const ledGroup = leadsGroup(pid)
        const dirsWhileRunning = scratchDirs(scratch)
        runner.child.kill(signal)
        // The message is built after `ended` resolves, so it holds all of stderr.
        assert.equal(await runner.ended, signal, `the test process did not end on ${signal}; its stderr:\n${runner.stderr()}`)
        if (!(await exits(pid, 5_000))) stillRuns = pid
        assert.equal(stillRuns, 0, `process ${pid}, started by the documented commands, still runs`)
        assert.ok(!ledGroup, `process ${pid} led the process group, so its stopping does not show the group was stopped`)
        assert.equal(dirsWhileRunning.length, 1, `the runner had ${dirsWhileRunning.length} scratch directories, not 1`)
        assert.deepEqual(scratchDirs(scratch), [], `the test process did not remove its scratch directory on ${signal}`)
      } finally {
        if (stillRuns > 0) {
          try {
            process.kill(stillRuns, 'SIGKILL')
          } catch {}
        }
        await stopRunner(runner)
      }
    }),
  )
}

// The cleanup a signal test runs when it fails before it sends its signal, for
// example because the process id was not recorded in time.
test('a runner stopped while it runs stops the documented commands it started', () =>
  withScratch(async (scratch) => {
    const pidFile = join(scratch, 'pid')
    const helper = new URL('./run-as-documented.mjs', import.meta.url).href
    const runner = startRunner(helper, `node -e '${neverExits(pidFile)}'\necho done`, scratch)
    let stillRuns = 0
    try {
      const pid = await documentedPid(runner, pidFile, 10_000)
      const dirsWhileRunning = scratchDirs(scratch)
      await stopRunner(runner)
      if (!(await exits(pid, 5_000))) stillRuns = pid
      assert.equal(stillRuns, 0, `process ${pid}, started by the documented commands, still runs`)
      assert.equal(dirsWhileRunning.length, 1, `the runner had ${dirsWhileRunning.length} scratch directories, not 1`)
      assert.deepEqual(scratchDirs(scratch), [], 'the stopped runner did not remove its scratch directory')
    } finally {
      if (stillRuns > 0) {
        try {
          process.kill(stillRuns, 'SIGKILL')
        } catch {}
      }
      await stopRunner(runner)
    }
  }),
)

// A helper for startRunner whose runAsDocumented ignores SIGTERM and never
// returns. It takes the name of a file in place of commands and records the
// runner's process id there once its SIGTERM handler is installed, so a SIGTERM
// sent after that is ignored.
const ignoresSigterm = `data:text/javascript,${encodeURIComponent(`
import { writeFileSync } from 'node:fs'
export function runAsDocumented(pidFile) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  writeFileSync(pidFile, String(process.pid))
  return new Promise(() => {})
}`)}`

test('a runner that ignores SIGTERM is killed once the time to stop has passed', { timeout: 10_000 }, () =>
  withScratch(async (scratch) => {
    const pidFile = join(scratch, 'pid')
    const runner = startRunner(ignoresSigterm, pidFile, scratch)
    try {
      assert.equal(await documentedPid(runner, pidFile, 5_000), runner.child.pid)
      await stopRunner(runner, 500)
      const ended = await Promise.race([runner.ended, sleep(5_000, 'still running', { ref: false })])
      assert.equal(ended, 'SIGKILL', `the runner ignored SIGTERM and was not killed; its stderr:\n${runner.stderr()}`)
    } finally {
      // stopRunner is what this test checks, so it is not trusted to clean up.
      if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill('SIGKILL')
    }
  }),
)

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
