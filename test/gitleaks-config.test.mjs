// Guards the custom rules in .gitleaks.toml against a finding that prints the
// value it found in the job log of the secret scan.
//
// gitleaks takes as the secret the first non-empty capture group of a rule's
// regex, or the whole match when the regex captures nothing, and --redact
// replaces only that text. A rule that captures the key name, the URL scheme or
// the key type is reported as `REDACTED = "<the value>"`.
//
// The check reads the rules the way this file writes them: a `[[rules]]` table
// with an `id` and a `regex` in a ''' literal string, with an optional leading
// `(?i)`. It does not read `secretGroup`; a rule that sets it fails here until
// parseRules learns it. Three tests also run gitleaks: one on the same lines,
// one on the lines in NOT_REPORTED and one on the lines in REPORTED. They run
// only when the gitleaks on the PATH is GITLEAKS_VERSION, and skip with a
// message otherwise.
//
// The value a rule captures is also the text gitleaks tests its global
// allowlist against, and that allowlist includes the one in the default
// configuration .gitleaks.toml extends. NOT_REPORTED holds lines that match a
// rule's regex and that gitleaks does not report for that reason, one for each
// kind of value the comment in .gitleaks.toml names. REPORTED holds the lines
// that comment names as close to one of those kinds and still reported.
//
// The sample lines are assembled from parts at run time, so the source of this
// file holds nothing a secret scanner reports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const configPath = path.join(root, '.gitleaks.toml')
const config = readFileSync(configPath, 'utf8')

function parseRules(text) {
  return text.split(/^\[\[rules\]\]$/m).slice(1).map((block) => {
    const id = /^id = "([^"]+)"$/m.exec(block)?.[1]
    const regex = /^regex = '''(.*)'''$/m.exec(block)?.[1]
    assert.ok(id && regex, `a [[rules]] table without an id or a ''' regex:\n${block}`)
    assert.doesNotMatch(block, /^secretGroup\s*=/m, `${id} sets secretGroup, which this check does not read`)
    return { id, regex }
  })
}

// The rule's regex as JavaScript reads it. The patterns here use only syntax
// that RE2 and JavaScript read alike, apart from the leading `(?i)`.
function compile(source) {
  return source.startsWith('(?i)') ? new RegExp(source.slice(4), 'i') : new RegExp(source)
}

// The text gitleaks reports as the secret of a match.
function secretOf(groups) {
  return groups.slice(1).find((group) => group) ?? groups[0]
}

const value = ['not', 'a', 'real', 'value', '0123456789'].join('-')
const password = ['not', 'a', 'real', 'pass'].join('-')
const segment = 'notarealtoken'
const token = ['ey' + 'J' + segment, 'ey' + 'J' + segment, segment].join('.')
const pemHeader = '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----'

// One line per rule, and the text in it that --redact must not leave in the
// log. A rule added to .gitleaks.toml needs a line here.
const SAMPLES = {
  'api-key-generic': { line: `${['api', 'key'].join('_')} = "${value}"`, hidden: value },
  'jwt-token': { line: `token: ${token}`, hidden: token },
  'pem-private-key': { line: pemHeader, hidden: pemHeader },
  'database-password': {
    line: `url = "${'postgres' + ':' + '//'}appuser${':' + password + '@'}db.internal:5432/app"`,
    hidden: password,
  },
}

const rules = parseRules(config)

test('.gitleaks.toml defines custom rules, and each has a sample line here', () => {
  assert.ok(rules.length > 0)
  assert.deepEqual(rules.map((rule) => rule.id).sort(), Object.keys(SAMPLES).sort())
})

for (const rule of rules) {
  test(`${rule.id}: --redact leaves nothing of the value in the finding`, () => {
    const sample = SAMPLES[rule.id]
    const groups = compile(rule.regex).exec(sample.line)
    assert.ok(groups, `${rule.id} does not match its sample line`)
    const secret = secretOf(groups)
    assert.ok(secret.includes(sample.hidden), `${rule.id} reports ${JSON.stringify(secret)} as the secret, not the value`)
    for (const text of [groups[0], sample.line]) {
      assert.ok(!text.replaceAll(secret, 'REDACTED').includes(sample.hidden), `${rule.id} leaves the value in ${JSON.stringify(text)}`)
    }
  })
}

// The gitleaks version NOT_REPORTED is measured with, the one the secret scan
// in .github/workflows/security.yml installs. Another version can test the
// default allowlist another way, so the tests that run gitleaks skip on it.
const GITLEAKS_VERSION = '8.30.1'

// Why the tests that run gitleaks skip, given the result of `gitleaks version`,
// or false when they run.
function gitleaksSkip(result) {
  if (result.error) return 'gitleaks is not on the PATH'
  const version = (result.stdout ?? '').trim().replace(/^v/, '')
  if (version === GITLEAKS_VERSION) return false
  return `the gitleaks on the PATH is ${JSON.stringify(version)}, and the lines here are measured with gitleaks ${GITLEAKS_VERSION}`
}

test(`the tests that run gitleaks skip, with a message, unless the gitleaks on the PATH is ${GITLEAKS_VERSION}`, () => {
  assert.equal(gitleaksSkip({ stdout: `${GITLEAKS_VERSION}\n` }), false)
  assert.equal(gitleaksSkip({ stdout: `v${GITLEAKS_VERSION}\n` }), false)
  assert.match(gitleaksSkip({ stdout: '8.18.0\n' }), /"8\.18\.0".*8\.30\.1/)
  assert.match(gitleaksSkip({ stdout: '8.30.10\n' }), /"8\.30\.10"/)
  assert.match(gitleaksSkip({ stdout: '', status: 1 }), /""/)
  assert.equal(gitleaksSkip({ error: new Error('spawnSync gitleaks ENOENT') }), 'gitleaks is not on the PATH')
})

test('GITLEAKS_VERSION is the version the secret scan installs', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'security.yml'), 'utf8')
  const pinned = /^\s*GITLEAKS_VERSION:\s*"([^"]+)"\s*$/m.exec(workflow)?.[1]
  assert.equal(pinned, GITLEAKS_VERSION, 'the secret scan installs another gitleaks version: measure NOT_REPORTED with it, then set GITLEAKS_VERSION')
})

const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' })
const skip = gitleaksSkip(gitleaks)

test('gitleaks reports each sample line under its rule and prints no value', { skip }, () => {
  const input = Object.values(SAMPLES).map((sample) => sample.line).join('\n') + '\n'
  const run = spawnSync('gitleaks', ['stdin', '--config', configPath, '--redact', '--verbose', '--no-color', '--no-banner'], { input, encoding: 'utf8' })
  const output = `${run.stdout}\n${run.stderr}`
  assert.equal(run.status, 1, output)
  for (const [id, sample] of Object.entries(SAMPLES)) {
    assert.match(output, new RegExp(`^RuleID:\\s+${id}$`, 'm'), `gitleaks did not report ${id}`)
    assert.ok(!output.includes(sample.hidden), `the output of gitleaks holds the value from the ${id} sample`)
  }
})

const keyLine = (text) => `${['api', 'key'].join('_')} = "${text}"`
const urlLine = (text) => `url = "${'postgres' + ':' + '//'}appuser${':' + text + '@'}db.internal:5432/app"`
const alphabet = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index)).join('')
// The stopword of the default allowlist that is not the alphabet.
const stopword = ['014df517', '39d1', '4453', 'b7b3', '9930c563627c'].join('-')
// The text with each <U+XXXX> in it replaced by that character, so the source
// of this file stays ASCII and reads like the comment of .gitleaks.toml.
const unicode = (text) => text.replace(/<U\+([0-9A-F]{4,6})>/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))

// Lines the secret scan does not report, measured with GITLEAKS_VERSION, each
// with the words in the comment of .gitleaks.toml that name its kind of value.
// While these rules captured the key name or the URL scheme, the allowlist was
// tested against that text, and gitleaks reported each of these lines.
const NOT_REPORTED = [
  { id: 'api-key-generic', kind: 'one repeated letter', line: keyLine('x'.repeat(32)) },
  { id: 'api-key-generic', kind: 'the alphabet in order', line: keyLine(`${alphabet}012345`) },
  { id: 'api-key-generic', kind: stopword, line: keyLine(stopword) },
  { id: 'api-key-generic', kind: 'starts with `true`', line: keyLine('true-not-a-real-value') },
  { id: 'api-key-generic', kind: 'contains `false`', line: keyLine('not-a-false-real-value') },
  { id: 'api-key-generic', kind: 'ends with `null`', line: keyLine('not-a-real-value-null') },
  { id: 'api-key-generic', kind: '`null`, in any case', line: keyLine('TRUE-not-a-real-value') },
  { id: 'api-key-generic', kind: 'the stopwords in any case', line: keyLine(stopword.toUpperCase()) },
  { id: 'database-password', kind: 'one repeated letter', line: urlLine('x'.repeat(10)) },
  { id: 'database-password', kind: 'the alphabet in order', line: urlLine(alphabet) },
  { id: 'database-password', kind: stopword, line: urlLine(stopword) },
  { id: 'database-password', kind: 'starts with `true`', line: urlLine('trueblue2024') },
  { id: 'database-password', kind: 'contains `false`', line: urlLine('not-a-false-pass') },
  { id: 'database-password', kind: 'ends with `null`', line: urlLine('not-a-pass-null') },
  { id: 'database-password', kind: '`null`, in any case', line: urlLine('TRUEblue2024') },
  { id: 'database-password', kind: 'a run of `*`', line: urlLine('*'.repeat(10)) },
  { id: 'database-password', kind: 'a run of `.`', line: urlLine('.'.repeat(10)) },
  { id: 'database-password', kind: '$NAME', line: urlLine('$' + 'DB_PASSWORD') },
  { id: 'database-password', kind: '${NAME}', line: urlLine('$' + '{DB_PASSWORD}') },
  { id: 'database-password', kind: 'a $ followed by digits', line: urlLine('$' + '12345678') },
  { id: 'database-password', kind: 'digits in braces', line: urlLine('$' + '{12345678}') },
  { id: 'database-password', kind: '%NAME%', line: urlLine('%' + 'DB_PASSWORD' + '%') },
  { id: 'database-password', kind: '{{name}}', line: urlLine('{{' + 'password' + '}}') },
  { id: 'database-password', kind: '{{.Values.name}}', line: urlLine('{{' + '.Values.password' + '}}') },
  { id: 'database-password', kind: '{{.Values.db|quote}}', line: urlLine('{{' + '.Values.db|quote' + '}}') },
  { id: 'database-password', kind: '{{(password)}}', line: urlLine('{{' + '(password)' + '}}') },
  { id: 'database-password', kind: '{{........}}', line: urlLine('{{' + '.'.repeat(8) + '}}') },
  { id: 'database-password', kind: '${{secrets.NAME}}', line: urlLine('$' + '{{' + 'secrets.DB_PASSWORD' + '}}') },
  ...['env', 'vars', 'github'].map((context) => ({ id: 'database-password', kind: '${{' + context + '.NAME}}', line: urlLine('$' + '{{' + context + '.DB_PASSWORD' + '}}') })),
  { id: 'database-password', kind: '${{secrets.DB.PASSWORD}}', line: urlLine('$' + '{{' + 'secrets.DB.PASSWORD' + '}}') },
  { id: 'database-password', kind: "${{env.DB_PASSWORD||'x'}}", line: urlLine('$' + '{{' + "env.DB_PASSWORD||'x'" + '}}') },
  ...['bin', 'etc', 'home', 'opt', 'tmp', 'usr', 'var'].map((dir) => ({ id: 'database-password', kind: `/${dir}/`, line: urlLine(`/${dir}/dbpassword`) })),
  { id: 'database-password', kind: '/Users/<name>/', line: urlLine('/Users/app/dbpassword') },
  { id: 'database-password', kind: 'match in any case', line: urlLine('$' + 'DbPassword') },
  { id: 'database-password', kind: 'match in any case', line: urlLine('/TMP/dbpassword') },
  { id: 'database-password', kind: 'match in any case', line: urlLine('$' + 'ecretPass') },
  { id: 'database-password', kind: '{{<U+212A>eyname}}', line: urlLine('{{' + unicode('<U+212A>eyname') + '}}') },
  { id: 'database-password', kind: '${{secrets.pa<U+017F><U+017F>word}}', line: urlLine('$' + '{{' + unicode('secrets.pa<U+017F><U+017F>word') + '}}') },
]

// Lines the secret scan reports, measured with GITLEAKS_VERSION, though they
// differ from a kind of value in NOT_REPORTED by one character, each with the
// words in the comment of .gitleaks.toml that name it.
const REPORTED = [
  { id: 'database-password', kind: '{{p<U+00E4>ssword}}', line: urlLine('{{' + unicode('p<U+00E4>ssword') + '}}') },
  { id: 'database-password', kind: '${{secrets.P<U+00C4>SSWORD}}', line: urlLine('$' + '{{' + unicode('secrets.P<U+00C4>SSWORD') + '}}') },
]

// The comment of .gitleaks.toml as one line of text.
const configComment = config.split('\n').filter((text) => text.startsWith('#')).map((text) => text.replace(/^#\s?(?:-\s)?/, '')).join(' ').replace(/\s+/g, ' ')

test('the comment in .gitleaks.toml names each kind of value in NOT_REPORTED', () => {
  for (const { id, kind } of NOT_REPORTED) {
    assert.ok(configComment.includes(kind), `the comment in .gitleaks.toml does not name ${JSON.stringify(kind)}, a kind of value ${id} does not report`)
  }
})

test('gitleaks does not report a line whose value its global allowlist matches', { skip }, () => {
  for (const { id, kind, line } of NOT_REPORTED) {
    const rule = rules.find((candidate) => candidate.id === id)
    assert.ok(rule && compile(rule.regex).test(line), `${id} does not match its line for ${JSON.stringify(kind)}`)
    const run = spawnSync('gitleaks', ['stdin', '--config', configPath, '--redact', '--verbose', '--no-color', '--no-banner'], { input: `${line}\n`, encoding: 'utf8' })
    assert.equal(run.status, 0, `gitleaks ${gitleaks.stdout.trim()} reports the ${id} line for ${JSON.stringify(kind)}:\n${run.stdout}\n${run.stderr}`)
  }
})

test('the comment in .gitleaks.toml names each value in REPORTED', () => {
  for (const { id, kind } of REPORTED) {
    assert.ok(configComment.includes(kind), `the comment in .gitleaks.toml does not name ${JSON.stringify(kind)}, a value ${id} reports`)
  }
})

test('gitleaks reports each line in REPORTED under its rule and prints no value', { skip }, () => {
  for (const { id, kind, line } of REPORTED) {
    const rule = rules.find((candidate) => candidate.id === id)
    assert.ok(rule && compile(rule.regex).test(line), `${id} does not match its line for ${JSON.stringify(kind)}`)
    const run = spawnSync('gitleaks', ['stdin', '--config', configPath, '--redact', '--verbose', '--no-color', '--no-banner'], { input: `${line}\n`, encoding: 'utf8' })
    const output = `${run.stdout}\n${run.stderr}`
    assert.equal(run.status, 1, `gitleaks ${gitleaks.stdout.trim()} does not report the ${id} line for ${JSON.stringify(kind)}:\n${output}`)
    assert.match(output, new RegExp(`^RuleID:\\s+${id}$`, 'm'), `gitleaks reports the line for ${JSON.stringify(kind)}, but not under ${id}:\n${output}`)
    assert.ok(!output.includes(unicode(kind)), `the output of gitleaks holds the value ${JSON.stringify(kind)}`)
  }
})
