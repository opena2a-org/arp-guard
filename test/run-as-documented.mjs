// Runs README commands the way a reader runs them: pasted into bash, in its own
// process, in a directory where `require('arp-guard')` resolves to this
// repository's build. The commands are README text, so they are never evaluated
// inside the test process. They get PATH and nothing else from the runner's
// environment, and a time limit, so a script that never exits fails the test.
// At the limit every process in the process group bash leads is stopped; a
// process that starts a session or group of its own is outside that group and
// keeps running.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))

// The process groups of the runs still going. Each leads a group of its own,
// outside the terminal's foreground group, so a Ctrl-C at the terminal reaches
// this process but not them. Stop them before this process ends, then end the
// way the signal would have ended it.
const running = new Set()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const pid of running) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
  })
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
export async function runAsDocumented(commands, { timeout = 30_000 } = {}) {
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
      if (child.pid) running.add(child.pid)
      const output = { stdout: '', stderr: '', timedOut: false, exitedBeforeLimit: false }
      child.stdout.setEncoding('utf8').on('data', (chunk) => (output.stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk) => (output.stderr += chunk))
      // 'close' waits for stdout and stderr to close as well, which a process
      // bash started can hold open after bash has exited.
      let exited = false
      child.on('exit', () => (exited = true))
      const timer = setTimeout(() => {
        output.timedOut = true
        output.exitedBeforeLimit = exited
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
        running.delete(child.pid)
        reject(error)
      })
      child.on('close', (status, signal) => {
        clearTimeout(timer)
        running.delete(child.pid)
        resolve({ ...output, status, signal })
      })
    })
    if (run.timedOut && run.exitedBeforeLimit) {
      throw new Error(
        `the documented commands exited, but a process they started still held stdout or stderr open after ${timeout} ms`,
      )
    }
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
