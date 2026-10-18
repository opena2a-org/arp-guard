// Guards the links in the pages the package ships. An install holds what
// `files` in package.json lists, and a reader of the installed README follows
// its links there. While `files` listed `dist`, README.md and LICENSE, the
// README's links to docs/, STATUS.md and CHANGELOG.md named files the package
// did not ship.
//
// What ships is read from `npm pack --dry-run`, which lists the files the
// package would publish and writes no tarball. npm gets PATH from the runner's
// environment and a scratch HOME, so it reads no configuration from the user's
// home directory, and what it writes under HOME, such as its log, goes to the
// scratch directory, which is removed after.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// The paths, relative to the package root, of the files npm would publish.
function packedFiles() {
  const home = mkdtempSync(path.join(tmpdir(), 'arp-pack-'))
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, npm_config_update_notifier: 'false' },
    })
    assert.equal(result.status, 0, `\`npm pack --dry-run\` failed: ${result.error ?? result.stderr}`)
    const [pack] = JSON.parse(result.stdout)
    return new Set(pack.files.map((file) => file.path))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// The targets of the Markdown links in `text` that name a path: inline links,
// `[text](target)`, and reference definitions, `[label]: target`, outside
// fenced code blocks, each without its `#fragment`. A URL and a link to a
// heading on the same page name no path.
function localLinks(text) {
  let fenced = false
  const prose = text
    .split('\n')
    .filter((line) => {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
        fenced = !fenced
        return false
      }
      return !fenced
    })
    .join('\n')
  return [...prose.matchAll(/\]\(([^)\s]+)\)|^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)]
    .map((match) => match[1] ?? match[2])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
    .map((target) => target.split('#')[0])
}

test('the links read from a page are its inline links and reference definitions that name a path, outside code blocks', () => {
  const text = [
    '[a](docs/a.md) and [b](docs/b.md#part) and [c](#heading)',
    '[![badge](https://example.com/badge.svg)](STATUS.md)',
    '[site](https://example.com/page) and [mail](mailto:someone@example.com)',
    '[ref]: ../README.md#top',
    '```md',
    '[in a code block](not-a-link.md)',
    '```',
  ].join('\n')
  assert.deepEqual(localLinks(text), ['docs/a.md', 'docs/b.md', 'STATUS.md', '../README.md'])
})

test('each link from a page the package ships to a path names a file the package ships', () => {
  const packed = packedFiles()
  const pages = [...packed].filter((file) => file.endsWith('.md')).sort()
  assert.ok(pages.includes('README.md'), 'the package does not ship README.md')
  const missing = []
  for (const page of pages) {
    for (const target of localLinks(readFileSync(path.join(root, page), 'utf8'))) {
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(page), target))
      if (!packed.has(file)) missing.push(`${page} links ${target}, which the package does not ship`)
    }
  }
  assert.deepEqual(missing, [])
})
