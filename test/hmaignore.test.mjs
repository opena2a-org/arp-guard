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
// hackmyagent applies. It also rejects these, which hackmyagent applies:
//   a `*` that is not the whole last segment of a check pattern: `!AIM*`,
//     `!*-001`
//   a check pattern whose `*` is the whole last segment but that is not a
//     letter-led ID of two or more segments: `!*` (which matches every check),
//     `!1AIM-*`, `!0-*`
//   a path containing `?`, `[`, `]`, `{` or `}`; hackmyagent globs on `*` only,
//     so `app/[slug]/page.tsx` is a path
//   a path containing a space: `my dir/file`, `my dir:AIM-001 # reason`
//   `expires:` in any case but lowercase: `!AIM-001 EXPIRES:2026-12-31`
//   whitespace other than a space or tab before `expires:`, such as the
//     no-break space in `src<U+00A0>expires:2026-12-31`; this check splits a
//     rule on spaces and tabs only, so it reads that line as `path:CHECK-ID`
//   a `#` with no reason after a `!CHECK-ID` or path rule: `!AIM-001 #`,
//     `src/ #`
//   a path with a colon in it, which this check reads as `path:CHECK-ID`:
//     `snapshot-10:30`
// To write one of those here, widen parseLine first.

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
// `#` is part of the rule text, as it is to hackmyagent, so other whitespace
// before a `#`, such as the no-break space in `src #bar`, leaves the `#` in the
// path. This check also splits the rule before the `#` on spaces and tabs
// only, where hackmyagent takes `expires:` off the end after any whitespace;
// the header names that form among the ones this check rejects.
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
  const tokens = head.split(/[ \t]+/)
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

const lines = readFileSync(path.join(root, '.hmaignore'), 'utf8').split('\n')
const entries = lines.map((text, index) => ({ at: `.hmaignore:${index + 1}`, text, parsed: parseLine(text) }))
const rules = entries.filter(({ parsed }) => parsed.kind !== 'blank' && parsed.kind !== 'comment')

// The comment at the top of a .hmaignore, each line without its `#`. It ends at
// the first line that is not a comment, so a comment under a rule is not part
// of it.
function headerOf(lines) {
  const comment = []
  for (const text of lines) {
    if (!text.startsWith('#')) break
    comment.push(text.slice(1))
  }
  return comment
}

// A line of that comment that names a rule form: three spaces, then the form.
const FORM = /^ {3}(\S+)/

// The rule forms the comment at the top of a .hmaignore names.
function formsIn(lines) {
  return headerOf(lines).map((line) => line.match(FORM)?.[1]).filter(Boolean)
}

// A form line split at the gap before its description: the `# reason` the form
// carries, as `path:CHECK-ID # reason` does, without its `# `, or null, then the
// text after the gap. The gap is two or more spaces right after the form or
// after its `# reason`, so a description set off by one space or a tab is not
// read from after a double space inside it. A `# reason` ends at the widest run
// of two or more spaces with text after it, the first of them if several are as
// wide: the comment sets its descriptions in a column, so a double space inside
// a reason or a description is narrower than the gap before the description.
// When the only run of two or more spaces after a `# reason` ends the line, the
// reason ends at it and the text after the gap is empty, as it is for a form
// with no `# reason` and only spaces after it. With no run of two or more spaces
// after a `# reason`, the reason runs to the end of the line, without the
// whitespace at its end, and the line has no gap. With no gap, the text after it
// is the whole line, form and all.
function splitFormLine(line) {
  const reasonAt = /^ {3}\S+ # (?=\S)/.exec(line)
  if (reasonAt) {
    const rest = line.slice(reasonAt[0].length)
    let gap = null
    for (const run of rest.matchAll(/ {2,}/g)) {
      const atEnd = run.index + run[0].length === rest.length
      if (gap === null || (!atEnd && run[0].length > gap[0].length)) gap = run
    }
    if (gap) return { reason: rest.slice(0, gap.index), description: rest.slice(gap.index + gap[0].length) }
    return { reason: rest.trimEnd(), description: line }
  }
  const gap = /^ {3}\S+ {2,}/.exec(line)
  return { reason: null, description: gap ? line.slice(gap[0].length) : line }
}

// The `# reason` the line of a form carries in the comment at the top of
// .hmaignore, without its `# `, or null.
function reasonOf(form, from = lines) {
  const line = headerOf(from).find((line) => line.match(FORM)?.[1] === form)
  return line === undefined ? null : splitFormLine(line).reason
}

// What the comment at the top of .hmaignore says one rule form does: the text
// after the form on its own line, then the indented lines under it, each
// without the spaces at its end, so they do not read as a gap between words.
function describedAs(form, from = lines) {
  const comment = headerOf(from)
  const start = comment.findIndex((line) => line.match(FORM)?.[1] === form)
  if (start === -1) return null
  const said = [splitFormLine(comment[start]).description.trimEnd()]
  for (const line of comment.slice(start + 1)) {
    if (!/^ {4,}\S/.test(line)) break
    said.push(line.trim())
  }
  return said.join(' ')
}

// What is wrong with the description describedAs returned for a form, or null.
// A form is set off from its description by two or more spaces, and the
// description's own words by one. describedAs reads a description from after
// all the spaces of that gap, so one that is empty or starts with a space comes
// from a form line with no description after such a gap: the form text left in
// place, with or without a description set off from it by one space or a tab,
// or nothing before the lines under it. A description that starts with
// `#` holds part of the form, such as the `# reason` of `path:CHECK-ID # reason`.
// Two or more spaces inside it are either part of the form read the same way or
// a double space in the header's own words, so the message names the words on
// each side.
function descriptionProblem(form, said) {
  if (said === '' || said.startsWith(' ')) {
    return `the line of \`${form}\` carries no description set off from the form by two or more spaces; write it on that line after such a gap: "${said}"`
  }
  if (said.startsWith('#')) {
    return `the description of \`${form}\` starts with \`#\`, so part of the form was read as its description: "${said}"`
  }
  const doubled = doubleSpaceIn(said)
  if (doubled) return `the description of \`${form}\` has ${doubled}, where its words are set off by one: "${said}"`
  return null
}

// What is wrong with the `# reason` reasonOf returned for a form, or null: its
// words are set off by one space, as a description's are.
function reasonProblem(form, reason) {
  const doubled = reason === null ? null : doubleSpaceIn(reason)
  if (doubled) return `the \`# reason\` of \`${form}\` has ${doubled}, where its words are set off by one: "${reason}"`
  return null
}

// The first run of two or more spaces in a text, named by its width and the
// words on each side of it, or null.
function doubleSpaceIn(text) {
  const gap = / {2,}/.exec(text)
  if (!gap) return null
  const before = text.slice(0, gap.index).split(' ').at(-1)
  const after = text.slice(gap.index + gap[0].length).split(' ')[0]
  return `${gap[0].length} spaces between "${before}" and "${after}"`
}

test('describedAs returns each form\'s description without the rest of the form', () => {
  const forms = formsIn(lines)
  assert.ok(forms.includes('path:CHECK-ID'), 'the comment at the top of .hmaignore does not describe the `path:CHECK-ID` form')
  // describedAs reads the same comment with the same FORM pattern as formsIn,
  // so it finds every form formsIn returns.
  for (const form of forms) {
    const said = describedAs(form)
    const problem = descriptionProblem(form, said)
    assert.equal(problem, null, problem)
    const inReason = reasonProblem(form, reasonOf(form))
    assert.equal(inReason, null, inReason)
  }
})

// A comment under a rule may be indented like a form; it is not part of the
// comment at the top that describes the forms.
test('the forms are read from the comment at the top of .hmaignore only', () => {
  const noted = [...lines, '#   note  the rule above is renewed each quarter']
  assert.deepEqual(formsIn(noted), formsIn(lines))
})

// Spaces at the end of a form's line are not part of its description, the same
// as spaces at the end of the lines under it.
test('spaces at the end of a form\'s line do not widen the gap before the next line', () => {
  const forms = formsIn(lines)
  assert.notEqual(forms.length, 0, 'the comment at the top of .hmaignore names no rule form')
  for (const form of forms) {
    const start = headerOf(lines).findIndex((line) => line.match(FORM)?.[1] === form)
    const trailing = lines.map((text, index) => (index === start || index === start + 1 ? `${text}  ` : text))
    const said = describedAs(form, trailing)
    assert.equal(said, describedAs(form), `spaces at the end of the lines of \`${form}\` changed its description`)
    const problem = descriptionProblem(form, said)
    assert.equal(problem, null, problem)
  }
})

test('a misread description is reported by what was found in it', () => {
  assert.equal(descriptionProblem('path:CHECK-ID', 'that one check on that one path'), null)
  assert.match(
    descriptionProblem('path:CHECK-ID', '# reason   that one check on that one path'),
    /starts with `#`, so part of the form was read as its description/,
  )
  const doubled = descriptionProblem('!CHECK-ID', 'still scored,  still in the verdict')
  assert.match(doubled, /has 2 spaces between "scored," and "still"/)
  assert.doesNotMatch(doubled, /starts with/, 'a double space inside a description is not the description starting with the form')
})

// A form line that carries no description after the form gives describedAs one
// of two things. With nothing after the form, the form text is left in what it
// returns, before the lines under the form. With spaces after the form, those
// spaces are read as the gap before a description, so it returns the lines
// under the form with a leading space and no form text. Either way the message
// says the line has no description, not that there is a gap after an empty word.
test('a form line with no description after the form is reported as having none', () => {
  const start = headerOf(lines).findIndex((line) => line.match(FORM)?.[1] === '!CHECK-ID')
  assert.notEqual(start, -1, 'the comment at the top of .hmaignore does not describe the `!CHECK-ID` form')
  for (const [formLine, returned] of [
    ['#   !CHECK-ID', /^ {3}!CHECK-ID \S/],
    ['#   !CHECK-ID   ', /^ (?!.*!CHECK-ID)\S/],
  ]) {
    const bare = lines.map((text, index) => (index === start ? formLine : text))
    const said = describedAs('!CHECK-ID', bare)
    assert.match(said, returned, `${JSON.stringify(formLine)}: describedAs returned ${JSON.stringify(said)}`)
    const problem = descriptionProblem('!CHECK-ID', said)
    assert.match(problem, /the line of `!CHECK-ID` carries no description set off from the form by two or more spaces/, `${JSON.stringify(formLine)}: ${problem}`)
    assert.doesNotMatch(problem, /between ""/, `${JSON.stringify(formLine)}: ${problem}`)
  }
  assert.match(descriptionProblem('!CHECK-ID', '   !CHECK-ID still scored'), /carries no description set off from the form by two or more spaces/)
  assert.match(descriptionProblem('!CHECK-ID', ''), /carries no description set off from the form by two or more spaces/)
})

// A form line whose description is set off from the form by one space or a tab
// does carry a description; the message says it is not set off by two or more
// spaces, not that there is none. No gap comes right after the form, so
// describedAs leaves the whole line in what it returns, even when a run of three
// spaces and a word inside the description reads like a form and its gap.
test('a description set off from the form by one space or a tab is reported as not set off by two or more spaces', () => {
  for (const [form, formLine] of [
    ['!CHECK-ID', '#   !CHECK-ID the check is left off'],
    ['!CHECK-ID', '#   !CHECK-ID\tthe check is left off'],
    // A double space inside the description is not the gap after the form.
    ['!CHECK-ID', '#   !CHECK-ID the check  is left off'],
    ['!CHECK-ID', '#   !CHECK-ID\tthe check  is left off'],
    // Nor is three spaces, a word and two spaces inside it.
    ['!CHECK-ID', '#   !CHECK-ID the check   is  left off'],
    // Nor is a ` # ` inside the description, after three spaces and a word, the
    // `# reason` of the form.
    ['!CHECK-ID', '#   !CHECK-ID the check   is # left  off'],
    // A `#` with no reason before the gap is not the `# reason` of the form, so
    // the gap after it is not the gap after the form.
    ['path:CHECK-ID', '#   path:CHECK-ID #   that one check on that one path'],
  ]) {
    const start = headerOf(lines).findIndex((line) => line.match(FORM)?.[1] === form)
    assert.notEqual(start, -1, `the comment at the top of .hmaignore does not describe the \`${form}\` form`)
    const close = lines.map((text, index) => (index === start ? formLine : text))
    const said = describedAs(form, close)
    assert.ok(said.startsWith(formLine.slice(1)), `${JSON.stringify(formLine)}: describedAs returned ${JSON.stringify(said)}`)
    const problem = descriptionProblem(form, said)
    assert.match(problem, /carries no description set off from the form by two or more spaces/, `${JSON.stringify(formLine)}: ${problem}`)
    assert.ok(problem.startsWith(`the line of \`${form}\` `), `${JSON.stringify(formLine)}: ${problem}`)
    assert.doesNotMatch(problem, /no description after the form/, `${JSON.stringify(formLine)}: ${problem}`)
  }
})

// A form's `# reason` may hold a double space of its own. The description is
// still read from after the gap that sets it off, and the double space is
// reported in the reason, by the words on each side of it, not as a gap between
// the reason's last word and the description's first.
test('a double space inside a form\'s `# reason` is reported in the reason, not as the gap before the description', () => {
  const start = headerOf(lines).findIndex((line) => line.match(FORM)?.[1] === 'path:CHECK-ID')
  assert.notEqual(start, -1, 'the comment at the top of .hmaignore does not describe the `path:CHECK-ID` form')
  const withLine = (formLine) => lines.map((text, index) => (index === start ? formLine : text))
  const plain = withLine('#   path:CHECK-ID # my reason   that one check')
  const doubled = withLine('#   path:CHECK-ID # my  reason   that one check')
  const said = describedAs('path:CHECK-ID', doubled)
  assert.equal(said, describedAs('path:CHECK-ID', plain), 'the double space inside the `# reason` changed the description')
  assert.equal(descriptionProblem('path:CHECK-ID', said), null)
  assert.equal(reasonOf('path:CHECK-ID', plain), 'my reason')
  assert.equal(reasonProblem('path:CHECK-ID', reasonOf('path:CHECK-ID', plain)), null)
  const problem = reasonProblem('path:CHECK-ID', reasonOf('path:CHECK-ID', doubled))
  assert.match(problem ?? '', /the `# reason` of `path:CHECK-ID` has 2 spaces between "my" and "reason"/, problem)
  // A double space inside the description is narrower than the gap before it,
  // so it stays in the description and is reported there.
  const inDescription = withLine('#   path:CHECK-ID # my reason   that one  check')
  assert.equal(reasonOf('path:CHECK-ID', inDescription), 'my reason')
  assert.match(
    descriptionProblem('path:CHECK-ID', describedAs('path:CHECK-ID', inDescription)) ?? '',
    /the description of `path:CHECK-ID` has 2 spaces between "one" and "check"/,
  )
  // The gap may be two spaces wide, and of two runs as wide, the first ends the
  // reason. Spaces at the end of the line are not that gap, even when they are
  // wider than it.
  for (const formLine of [
    '#   path:CHECK-ID # my reason  that one check',
    '#   path:CHECK-ID # my reason  that one  check',
    '#   path:CHECK-ID # my reason  that one check   ',
  ]) {
    assert.equal(reasonOf('path:CHECK-ID', withLine(formLine)), 'my reason', JSON.stringify(formLine))
  }
  assert.equal(
    describedAs('path:CHECK-ID', withLine('#   path:CHECK-ID # my reason  that one check   ')),
    describedAs('path:CHECK-ID', plain),
    'spaces at the end of the line were read as the gap before the description',
  )
  // With only spaces after the `# reason`, those spaces end it and the line
  // carries no description, as a form with no `# reason` and only spaces after
  // it does.
  const spacesOnly = withLine('#   path:CHECK-ID # my reason   ')
  assert.equal(reasonOf('path:CHECK-ID', spacesOnly), 'my reason')
  assert.match(
    descriptionProblem('path:CHECK-ID', describedAs('path:CHECK-ID', spacesOnly)) ?? '',
    /the line of `path:CHECK-ID` carries no description set off from the form by two or more spaces/,
  )
})

// A form's `# reason` with no run of two or more spaces after it is still read:
// it runs to the end of the line, and the line carries no description set off
// from the form, so describedAs leaves the whole line in what it returns.
test('a form\'s `# reason` with no gap after it runs to the end of the line', () => {
  const start = headerOf(lines).findIndex((line) => line.match(FORM)?.[1] === 'path:CHECK-ID')
  assert.notEqual(start, -1, 'the comment at the top of .hmaignore does not describe the `path:CHECK-ID` form')
  const withLine = (formLine) => lines.map((text, index) => (index === start ? formLine : text))
  for (const [formLine, reason] of [
    ['#   path:CHECK-ID # my reason', 'my reason'],
    ['#   path:CHECK-ID # my reason x', 'my reason x'],
    // One space at the end of the line is not part of the reason.
    ['#   path:CHECK-ID # my reason ', 'my reason'],
  ]) {
    const close = withLine(formLine)
    assert.equal(reasonOf('path:CHECK-ID', close), reason, JSON.stringify(formLine))
    assert.equal(reasonProblem('path:CHECK-ID', reasonOf('path:CHECK-ID', close)), null, JSON.stringify(formLine))
    const said = describedAs('path:CHECK-ID', close)
    assert.ok(said.startsWith(formLine.slice(1).trimEnd()), `${JSON.stringify(formLine)}: describedAs returned ${JSON.stringify(said)}`)
    assert.match(
      descriptionProblem('path:CHECK-ID', said) ?? '',
      /the line of `path:CHECK-ID` carries no description set off from the form by two or more spaces/,
      JSON.stringify(formLine),
    )
  }
})

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
  // hackmyagent (0.33.2) reads each of these as one path.
  for (const line of ['src #bar', 'src\v#bar']) {
    assert.deepEqual(parseLine(line), { kind: 'path', path: line, expires: null, reason: null }, `${JSON.stringify(line)} should parse as one path`)
  }
})

// The forms hackmyagent applies that this check rejects, one form per row: the
// example the header names the form by, then more lines in that form.
const APPLIED_NOT_TAKEN = [
  ['!AIM*', '!AIM-0*'],
  ['!*-001', 'package.json:*-001 # reason'],
  ['!*', '!1AIM-*', '!0-*'],
  ['app/[slug]/page.tsx', 'src/page?.ts', 'src/{a,b}/', 'src/a]b', 'src/a}b'],
  ['my dir/file', 'my dir:AIM-001 # reason'],
  ['!AIM-001 EXPIRES:2026-12-31', '!AIM-001 Expires:2026-12-31'],
  [
    'src expires:2026-12-31',
    'src\vexpires:2026-12-31',
    'src\fexpires:2026-12-31',
    '!AIM-001 expires:2026-12-31',
    'package.json:AIM-001 expires:2026-12-31 # reason',
  ],
  ['!AIM-001 #', 'src/ #'],
  ['snapshot-10:30'],
]

test('the grammar check rejects forms hackmyagent applies that this file does not use, and says the form is one it does not take', () => {
  for (const line of APPLIED_NOT_TAKEN.flat()) {
    const { error } = parseLine(line)
    assert.ok(error, `"${line}" should be rejected`)
    assert.match(error, /this check/, `"${line}": "${error}" should name the form as one this check does not take, not as one hackmyagent cannot apply`)
  }
})

test('the header names every form hackmyagent applies that the grammar check rejects', () => {
  const header = []
  for (const line of readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    header.push(line.slice(2).trim())
  }
  const said = header.join(' ')
  // The header writes a character outside printable ASCII, such as a no-break
  // space, as `<U+00A0>`.
  const shown = (line) => line.replace(/[^\x20-\x7e]/gu, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`)
  for (const [example] of APPLIED_NOT_TAKEN) {
    assert.ok(said.includes(`\`${shown(example)}\``), `the header at the top of this file does not name the form of \`${shown(example)}\``)
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

// hackmyagent (0.33.x) counts a `path:CHECK-ID` rule's excluded findings on the
// same Scope line as a path rule's: with this file's one rule,
// `package.json:AIM-001`, `secure --ci` prints "Scope 1 finding excluded by
// .hmaignore path rules (1 medium)".
test('the comment says a path:CHECK-ID rule counts its findings on the Scope line', () => {
  const said = describedAs('path:CHECK-ID')
  assert.ok(said, 'the comment at the top of .hmaignore does not describe the `path:CHECK-ID` form')
  assert.doesNotMatch(said, /named on the report's Scope line/, `the Scope line counts findings and names no path or check: "${said}"`)
  assert.match(said, /counted by severity on the report's Scope line/, `the \`path:CHECK-ID\` form should say its findings are counted by severity on the report's Scope line: "${said}"`)
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
