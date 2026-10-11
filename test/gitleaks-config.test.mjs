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
// parseRules learns it. When gitleaks is on the PATH, the last test also runs
// it on the same lines.
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

const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' })

test('gitleaks reports each sample line under its rule and prints no value', { skip: gitleaks.error ? 'gitleaks is not on the PATH' : false }, () => {
  const input = Object.values(SAMPLES).map((sample) => sample.line).join('\n') + '\n'
  const run = spawnSync('gitleaks', ['stdin', '--config', configPath, '--redact', '--verbose', '--no-color', '--no-banner'], { input, encoding: 'utf8' })
  const output = `${run.stdout}\n${run.stderr}`
  assert.equal(run.status, 1, output)
  for (const [id, sample] of Object.entries(SAMPLES)) {
    assert.match(output, new RegExp(`^RuleID:\\s+${id}$`, 'm'), `gitleaks did not report ${id}`)
    assert.ok(!output.includes(sample.hidden), `the output of gitleaks holds the value from the ${id} sample`)
  }
})
