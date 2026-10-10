// Guards .hmaignore against rules that hackmyagent cannot apply, or applies
// differently from how they read.
//
// The failure this exists to catch is silent. hackmyagent (0.33.x) does not
// apply a line it cannot parse: a `path:CHECK-ID` rule with no `# reason`, a
// check pattern such as `!AIM` or `!AIM-`, a glob in a path rule, or a bad or
// lapsed `expires:` date. It reports the line as a `.hmaignore:<line>` error
// that never changes the exit code, and the finding the rule was written for
// goes back into the score. An `expires:` written after the `#` is quieter
// still: it is read as part of the reason, so the rule applies and never
// expires. A rule on a path that is not in the repository covers nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

// `AIM-001`, `SCAN-UNREAD-001` or `AIM-*`; not `AIM` or `AIM-`.
const CHECK_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-(?:[A-Z0-9]+|\*)$/i
const GLOB = /[*?[\]{}]/

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// One line of .hmaignore: a blank line, a `#` comment, or one rule
//   !CHECK-ID | path:CHECK-ID | path   [expires:YYYY-MM-DD]   [# reason]
// Returns `{ error }` for a line hackmyagent would not apply as written.
function parseLine(raw) {
  const line = raw.trim()
  if (!line) return { kind: 'blank' }
  if (line.startsWith('#')) return { kind: 'comment' }

  const hash = line.indexOf('#')
  const head = (hash === -1 ? line : line.slice(0, hash)).trim()
  const reason = hash === -1 ? null : line.slice(hash + 1).trim()
  const tokens = head.split(/\s+/)
  let expires = null
  if (tokens.length > 1 && tokens.at(-1).startsWith('expires:')) {
    expires = tokens.pop().slice('expires:'.length)
  }

  if (tokens.length !== 1) {
    return { error: 'a rule is one check ID or path, then an optional `expires:YYYY-MM-DD`, then an optional `# reason`' }
  }
  if (expires !== null && !isDate(expires)) {
    return { error: `\`expires:${expires}\` is not a date written as YYYY-MM-DD` }
  }
  if (reason !== null && /\bexpires:/.test(reason)) {
    return { error: '`expires:` after the `#` is read as part of the reason, so the rule never expires; write it before the `#`' }
  }
  if (reason !== null && !reason) {
    return { error: 'the `#` is followed by no reason' }
  }

  const [body] = tokens
  if (body.startsWith('!')) {
    const checkId = body.slice(1)
    if (!CHECK_ID.test(checkId)) return { error: `\`${checkId}\` is not a check ID` }
    return { kind: 'check', checkId, expires, reason }
  }

  const colon = body.lastIndexOf(':')
  const rulePath = colon === -1 ? body : body.slice(0, colon)
  if (!rulePath) return { error: 'the rule names no path' }
  if (GLOB.test(rulePath)) return { error: `\`${rulePath}\` is a glob; a path rule takes a file or directory` }
  if (colon === -1) return { kind: 'path', path: rulePath, expires, reason }

  const checkId = body.slice(colon + 1)
  if (!CHECK_ID.test(checkId)) return { error: `\`${checkId}\` is not a check ID` }
  if (reason === null) return { error: 'a `path:CHECK-ID` rule requires a `# reason`' }
  return { kind: 'path-check', path: rulePath, checkId, expires, reason }
}

const entries = readFileSync(path.join(root, '.hmaignore'), 'utf8')
  .split('\n')
  .map((text, index) => ({ at: `.hmaignore:${index + 1}`, text, parsed: parseLine(text) }))
const rules = entries.filter(({ parsed }) => parsed.kind !== 'blank' && parsed.kind !== 'comment')

test('the grammar check accepts the forms hackmyagent applies and rejects the ones it does not', () => {
  for (const line of [
    '# a comment',
    '!AIM-001',
    '!AIM-*',
    '!SCAN-UNREAD-001 expires:2026-12-31',
    '!AIM-001 # reason',
    'src/',
    'package.json:AIM-001 # reason',
    'package.json:AIM-001 # a reason with # in it',
    'package.json:AIM-001 expires:2026-12-31 # reason',
  ]) {
    assert.equal(parseLine(line).error, undefined, `"${line}" should parse`)
  }
  for (const line of [
    '!AIM',
    '!AIM-',
    '*.md',
    'package.json:AIM-001',
    'package.json:AIM-001 #',
    'package.json:AIM # reason',
    'package.json:AIM-001 # reason expires:2026-12-31',
    'package.json:AIM-001 expires:2026-13-45 # reason',
    'package.json AIM-001',
  ]) {
    assert.ok(parseLine(line).error, `"${line}" should be rejected`)
  }
})

test('every line of .hmaignore is a comment or a rule hackmyagent applies as written', () => {
  for (const { at, text, parsed } of entries) {
    assert.equal(parsed.error, undefined, `${at} "${text.trim()}": ${parsed.error}`)
  }
})

test('every path a rule names is in the repository', () => {
  for (const { at, parsed } of rules) {
    if (parsed.path === undefined) continue
    assert.ok(existsSync(path.join(root, parsed.path)), `${at} names "${parsed.path}", which is not in the repository`)
  }
})

test('no rule has expired', () => {
  const now = Date.now()
  for (const { at, parsed } of rules) {
    if (parsed.expires === null) continue
    // hackmyagent applies the rule through the named day, UTC.
    const lapses = Date.parse(`${parsed.expires}T00:00:00Z`) + 24 * 60 * 60 * 1000
    assert.ok(lapses > now, `${at} expired on ${parsed.expires}; renew it with a new reason or remove it`)
  }
})

test('AIM-001 is left out on package.json only, with a reason and an expiry', () => {
  const aim = rules.filter(({ parsed }) => parsed.checkId === 'AIM-001')
  assert.deepEqual(
    aim.map(({ parsed }) => `${parsed.kind} ${parsed.path}`),
    ['path-check package.json'],
    '.hmaignore should carry exactly one AIM-001 rule, `package.json:AIM-001 expires:<date> # <reason>`',
  )
  assert.notEqual(aim[0].parsed.expires, null, 'the AIM-001 rule carries no `expires:` date')
})
