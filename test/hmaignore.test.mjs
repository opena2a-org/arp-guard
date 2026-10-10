// Guards .hmaignore against rules that hackmyagent cannot apply, or applies
// differently from how they read.
//
// The failure this exists to catch is silent. hackmyagent (0.33.x) does not
// apply a line it cannot parse: a `path:CHECK-ID` rule with no `# reason`, a
// check pattern such as `!AIM` or `!AIM-`, a `*` glob in a path rule, or a bad
// or lapsed `expires:` date. It reports the line as a `.hmaignore:<line>` error
// that never changes the exit code, and the finding the rule was written for
// goes back into the score. An `expires:` written after the `#` is quieter
// still: it is read as part of the reason, so the rule applies and never
// expires. A rule on a path that is not in the repository covers nothing.
//
// The check takes the forms this file uses, which are fewer than the forms
// hackmyagent applies. It also rejects these, which hackmyagent applies: a `*`
// that is not the whole last segment of a check pattern (`!AIM*`, `!*-001`), a
// path containing `?`, `[`, `]`, `{` or `}` (hackmyagent globs on `*` only, so
// `app/[slug]/page.tsx` is a path), `expires:` in any case but lowercase, a `#`
// with no reason after a `!CHECK-ID` or path rule, and a path with a colon in
// it (`snapshot-10:30`), which this check reads as `path:CHECK-ID`. To write
// one of those here, widen parseLine first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

// `AIM-001`, `SCAN-UNREAD-001` or `AIM-*`; not `AIM` or `AIM-`.
const CHECK_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-(?:[A-Z0-9]+|\*)$/i
// hackmyagent globs on `*` only; this check rejects the other glob characters too.
const GLOB = /[*?[\]{}]/

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// One line of .hmaignore: a blank line, a `#` comment, or one rule
//   !CHECK-ID | path:CHECK-ID | path   [expires:YYYY-MM-DD]   [# reason]
// The reason starts at the first `#` with a space or tab before it; any other
// `#` is part of the rule text, as it is to hackmyagent.
// Returns `{ error }` for a line hackmyagent would not apply as written, and for
// a line in a form this check does not take (see the header).
function parseLine(raw) {
  const line = raw.trim()
  if (!line) return { kind: 'blank' }
  if (line.startsWith('#')) return { kind: 'comment' }

  const comment = /[ \t]#/.exec(line)
  const hash = comment === null ? -1 : comment.index + 1
  const head = (hash === -1 ? line : line.slice(0, hash)).trim()
  const reason = hash === -1 ? null : line.slice(hash + 1).trim()
  const tokens = head.split(/\s+/)
  let expires = null
  if (tokens.length > 1 && tokens.at(-1).startsWith('expires:')) {
    expires = tokens.pop().slice('expires:'.length)
  }

  if (tokens.length !== 1) {
    return { error: 'this check takes a rule as one check ID or path, then an optional lowercase `expires:YYYY-MM-DD`, then an optional `# reason`' }
  }
  if (expires !== null && !isDate(expires)) {
    return { error: `\`expires:${expires}\` is not a date written as YYYY-MM-DD` }
  }
  if (reason !== null && /\bexpires:/.test(reason)) {
    return { error: '`expires:` after the `#` is read as part of the reason, so the rule never expires; write it before the `#`' }
  }
  if (reason !== null && !reason) {
    return { error: 'the `#` is followed by no reason; this check takes a `#` only with a reason after it' }
  }

  const [body] = tokens
  if (body.startsWith('!')) {
    const checkId = body.slice(1)
    if (!CHECK_ID.test(checkId)) return { error: `\`${checkId}\` is not a check ID in a form this check takes, such as \`AIM-001\` or \`AIM-*\`` }
    return { kind: 'check', checkId, expires, reason }
  }

  const colon = body.lastIndexOf(':')
  const rulePath = colon === -1 ? body : body.slice(0, colon)
  if (!rulePath) return { error: 'the rule names no path' }
  if (GLOB.test(rulePath)) return { error: `\`${rulePath}\` contains one of \`*?[]{}\`; this check takes a path with none of them` }
  if (colon === -1) return { kind: 'path', path: rulePath, expires, reason }

  const checkId = body.slice(colon + 1)
  if (!CHECK_ID.test(checkId)) {
    return { error: `this check reads \`${body}\` as \`path:CHECK-ID\`, and \`${checkId}\` is not a check ID in a form it takes, such as \`AIM-001\` or \`AIM-*\`` }
  }
  if (reason === null) return { error: 'a `path:CHECK-ID` rule requires a `# reason`' }
  return { kind: 'path-check', path: rulePath, checkId, expires, reason }
}

const entries = readFileSync(path.join(root, '.hmaignore'), 'utf8')
  .split('\n')
  .map((text, index) => ({ at: `.hmaignore:${index + 1}`, text, parsed: parseLine(text) }))
const rules = entries.filter(({ parsed }) => parsed.kind !== 'blank' && parsed.kind !== 'comment')

// What the comment at the top of .hmaignore says one rule form does: the text
// after the form on its own line, then the indented lines under it.
function describedAs(form) {
  const comment = []
  for (const { text } of entries) {
    if (!text.startsWith('#')) break
    comment.push(text.slice(1))
  }
  const start = comment.findIndex((line) => line.match(/^ {3}(\S+)/)?.[1] === form)
  if (start === -1) return null
  const said = [comment[start].replace(/^ {3}\S+\s+/, '')]
  for (const line of comment.slice(start + 1)) {
    if (!/^ {4,}\S/.test(line)) break
    said.push(line.trim())
  }
  return said.join(' ')
}

test('the grammar check accepts the forms this file uses and rejects lines outside them', () => {
  for (const line of [
    '# a comment',
    '!AIM-001',
    '!AIM-*',
    '!SCAN-UNREAD-001 expires:2026-12-31',
    '!AIM-001 # reason',
    'src/',
    'package.json:AIM-001 # reason',
    'package.json:AIM-001 # a reason with # in it',
    'package.json:AIM-001\t# reason',
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
    'package.json:AIM-001# reason',
    'package.json:AIM-001 expires:2026-12-31# reason',
  ]) {
    assert.ok(parseLine(line).error, `"${line}" should be rejected`)
  }
})

test('a `#` with no space or tab before it is part of the rule, not the start of a reason', () => {
  assert.deepEqual(parseLine('src#bar'), { kind: 'path', path: 'src#bar', expires: null, reason: null })
  assert.deepEqual(parseLine('src#bar # reason'), { kind: 'path', path: 'src#bar', expires: null, reason: 'reason' })
})

test('the grammar check rejects forms hackmyagent applies that this file does not use, and says the form is one it does not take', () => {
  for (const line of [
    '!AIM*',
    '!AIM-0*',
    '!*-001',
    'package.json:*-001 # reason',
    'app/[slug]/page.tsx',
    'src/page?.ts',
    'src/{a,b}/',
    'src/a]b',
    'src/a}b',
    '!AIM-001 EXPIRES:2026-12-31',
    '!AIM-001 Expires:2026-12-31',
    '!AIM-001 #',
    'src/ #',
    'snapshot-10:30',
  ]) {
    const { error } = parseLine(line)
    assert.ok(error, `"${line}" should be rejected`)
    assert.match(error, /this check/, `"${line}": "${error}" should name the form as one this check does not take, not as one hackmyagent cannot apply`)
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

// hackmyagent (0.33.x) applies a path rule to the findings after the checks have
// run: with `.hmaignore` holding only `package.json`, `secure` reports as many
// files read by static checks as with no such rule. The report's Scope line
// counts the excluded findings by severity and names no path.
test('the comment says a path rule leaves the file read and takes its findings out of the score', () => {
  const said = describedAs('path')
  assert.ok(said, 'the comment at the top of .hmaignore does not describe the `path` form')
  assert.doesNotMatch(said, /leaves? the scan/, `a path rule does not take the file out of the scan: "${said}"`)
  assert.doesNotMatch(said, /named on the report's Scope line/, `the Scope line counts findings and names no path: "${said}"`)
  assert.match(said, /\bstill read\b/, `the \`path\` form should say the file is still read: "${said}"`)
  assert.match(said, /findings leave the score and the exit code/, `the \`path\` form should say its findings leave the score and the exit code: "${said}"`)
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
