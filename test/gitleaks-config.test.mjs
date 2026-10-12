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
// that comment names as close to one of those kinds and still reported. The
// comment checks read each kind from the sentence of the comment it is named
// under, and fail when that sentence is not in CLAIMS, or when CLAIMS states
// next to it the opposite of what gitleaks does. The checks do not read from
// its words whether a sentence says not, since no list of words that can say
// not holds them all. They also fail when a word that is not in a value, `or`
// or `and` stands before the words of a claim in its sentence, such as the
// Never in "Never assume that <rule> does not report <value>", or between those
// words and a value named under them in their sentence, such as the but in
// "<rule> reports every value, but not <value>".
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
  { id: 'database-password', kind: '$<U+212A>EYNAME_X', line: urlLine('$' + unicode('<U+212A>EYNAME_X')) },
  { id: 'database-password', kind: '{{<U+212A>eyname}}', line: urlLine('{{' + unicode('<U+212A>eyname') + '}}') },
  { id: 'database-password', kind: '${{secrets.pa<U+017F><U+017F>word}}', line: urlLine('$' + '{{' + unicode('secrets.pa<U+017F><U+017F>word') + '}}') },
  { id: 'database-password', kind: '/tmp/pa<U+017F><U+017F>word', line: urlLine(unicode('/tmp/pa<U+017F><U+017F>word')) },
  // A value with a letter the {{...}} kind does not match, and that another
  // kind matches.
  { id: 'database-password', kind: '{{p<U+00E4>sswordfalse}}, which contains `false`', line: urlLine('{{' + unicode('p<U+00E4>sswordfalse') + '}}') },
  { id: 'database-password', kind: `{{<U+00E4>${alphabet}}}, which holds the alphabet`, line: urlLine('{{' + unicode('<U+00E4>') + alphabet + '}}') },
]

// Lines the secret scan reports, measured with GITLEAKS_VERSION, though they
// differ from a kind of value in NOT_REPORTED by one character, each with the
// words in the comment of .gitleaks.toml that name it.
const REPORTED = [
  { id: 'database-password', kind: '$P<U+00C4>SSWORD_X', line: urlLine('$' + unicode('P<U+00C4>SSWORD_X')) },
  { id: 'database-password', kind: '${P<U+00C4>SSWORD}', line: urlLine('$' + '{' + unicode('P<U+00C4>SSWORD') + '}') },
  { id: 'database-password', kind: '%P<U+00C4>SSWORD%', line: urlLine('%' + unicode('P<U+00C4>SSWORD') + '%') },
  { id: 'database-password', kind: '$1234567<U+0663>', line: urlLine('$' + unicode('1234567<U+0663>')) },
  { id: 'database-password', kind: '${1234567<U+0663>}', line: urlLine('$' + '{' + unicode('1234567<U+0663>') + '}') },
  { id: 'database-password', kind: '{{p<U+00E4>ssword}}', line: urlLine('{{' + unicode('p<U+00E4>ssword') + '}}') },
  { id: 'database-password', kind: '${{secrets.P<U+00C4>SSWORD}}', line: urlLine('$' + '{{' + unicode('secrets.P<U+00C4>SSWORD') + '}}') },
  { id: 'database-password', kind: '/tmp/p<U+00E4>ssword', line: urlLine(unicode('/tmp/p<U+00E4>ssword')) },
  { id: 'database-password', kind: '/Users/<U+00E4>pp/dbpassword', line: urlLine(unicode('/Users/<U+00E4>pp/dbpassword')) },
  { id: 'database-password', kind: '/tmp/pass<U+0663>word', line: urlLine(unicode('/tmp/pass<U+0663>word')) },
  { id: 'database-password', kind: '/Users/app<U+0663>/dbpassword', line: urlLine(unicode('/Users/app<U+0663>/dbpassword')) },
  { id: 'database-password', kind: '{{pass<U+0663>word}}', line: urlLine('{{' + unicode('pass<U+0663>word') + '}}') },
  { id: 'database-password', kind: '${{secrets.DB_PASSWORD<U+0663>}}', line: urlLine('$' + '{{' + unicode('secrets.DB_PASSWORD<U+0663>') + '}}') },
]

// The comment of .gitleaks.toml as one line of text.
const configComment = config.split('\n').filter((text) => text.startsWith('#')).map((text) => text.replace(/^#\s?(?:-\s)?/, '')).join(' ').replace(/\s+/g, ' ')

// Words from each sentence in the comment of .gitleaks.toml that says a rule
// reports, or does not report, a kind of value, and, stated next to them,
// what the sentence says of each kind named under them: reported, or not
// reported. The checks read that from here, not from the words, since a
// sentence can say not with any of many words, such as not, cannot, excluding,
// other than, seldom or omitted, and a word such as stopwords, nonce or
// exceptions can look like one. So when you change a sentence, read it again
// and state here what it says. A kind is named under the nearest of these
// before it in the sentence it is in, or else the first one after it in that
// sentence, or else the last one before that sentence, with the bullets and
// sentences after that one. So in a sentence that says both, such as "<rule>
// reports <kind>, so <rule> does not report <other kind>", each kind is named
// under the words before it. Words after a kind in its sentence that say what
// a rule reports can say it of that kind too, so they are in one of these as
// well, or the checks fail: "<rule> does not report <kind>, but <other kind>
// is reported" fails for both kinds. The words of a claim start where its
// sentence starts, since a word before them, such as Never or Nobody, can say
// the opposite of what they say. So the words of the second claim in a sentence
// hold those of the first, and when the words of several claims hold the word
// that says what a rule reports, the checks read the claim whose words end
// nearest after it, whatever the order here.
const CLAIMS = [
  { words: 'So api-key-generic and database-password do not report a value that allowlist matches', reported: false },
  { words: 'A value with any other letter or digit in those places is not of these kinds, so database-password reports values such as', reported: true },
  { words: 'It still does not report such a value when another kind above matches it, such as', reported: false },
  { words: 'The only exceptions are two letters, U+212A (the Kelvin sign) and U+017F (the long s), which the (?i) matches as k and s, so database-password does not report', reported: false },
]

// Every kind of value the comment checks read. A kind named inside a longer
// one, such as /tmp/ in /tmp/p<U+00E4>ssword, is read as the longer one there.
const KINDS = [...NOT_REPORTED, ...REPORTED].map(({ kind }) => kind)

// The words in the comment that say a rule reports, or does not report, a value:
// each word that holds `report`, in any form and any case, such as reports,
// report, reported, Reported or unreported. So a kind named in or after a
// sentence such as "<kind> is reported by database-password" is named under a
// sentence that is not in CLAIMS.
const VERB = /\w*report\w*/gi

// The words, other than values, that can stand before the words of a claim in
// its sentence, or between them and a value named under them in their
// sentence: those that join the values of a list, as in "<rule> does not
// report <kind>, <kind> or <kind>", or "<kind> and <kind> are not reported by
// <rule>". A comma can stand there too. Any other word there can change what
// the claim says of the value, as not does in "<rule> reports every value, but
// not <kind>", and Only does in "Only <kind> is reported by <rule>", so it fails
// the checks; put it in the words of a claim, and state what that claim says.
// The checks read no other word that is not in a claim: not one after both a
// claim and a value in their sentence, as in "<rule> reports <kind> only
// rarely", and not one in a sentence after the claim, such as a bullet, whose
// values are named under the claim before it.
const LISTED = ['or', 'and']

// The stops of a sentence: a `.`, `!` or `?` that a space or the end of the
// text follows, other than the `.` that ends e.g. or i.e., in any case, which a
// sentence goes on past. Only that `.` is not a stop: a `!` or `?` after e.g or
// i.e is one, and so is the `.` after a longer word that ends with those
// letters, such as page.g. or api.e.
const STOP = /(?:(?<!\b(?:e\.g|i\.e))\.|[!?])(?=\s|$)/gi

// The index in text where the sentence that holds the index from ends: the
// first stop from there on.
function sentenceEnd(text, from) {
  const stop = new RegExp(STOP)
  stop.lastIndex = from
  return stop.exec(text)?.index ?? text.length
}

// The index in text where the sentence that holds the index at starts: just
// after the last stop before it, or 0.
function sentenceStart(text, at) {
  let start = 0
  for (const stop of text.matchAll(STOP)) {
    if (stop.index >= at) break
    start = stop.index + 1
  }
  return start
}

// Each index in text where part starts. An empty part starts at every index,
// and indexOf finds it at the end of text from any index past that end, so it
// is refused.
function indexesOf(text, part) {
  assert.ok(typeof part === 'string' && part !== '', `indexesOf was given ${JSON.stringify(part)} to find, not text: an empty string is at every index`)
  const indexes = []
  for (let index = text.indexOf(part); index !== -1; index = text.indexOf(part, index + 1)) indexes.push(index)
  return indexes
}

// Each index in text where kind starts, outside a longer kind in KINDS.
function placesOf(text, kind) {
  const longer = KINDS.filter((other) => other.length > kind.length && other.includes(kind))
  return indexesOf(text, kind).filter((place) => !longer.some((other) => indexesOf(text, other).some((start) => start <= place && place + kind.length <= start + other.length)))
}

// The first word in comment, other than a word in a kind, a word in LISTED and
// a comma, between the words of a claim, from wordsStart to wordsStart +
// words.length, and a kind named in their sentence from place to place +
// length, or else before those words in their sentence, with where it stands;
// or nothing. Nothing stands between the two when the kind is in the words of
// the claim, and the words between them are read only when sameSentence is
// true. For "<rule> reports every value, but not <kind>" that is but, between
// them, and for "Never assume that <rule> does not report <kind>" it is Never,
// before them.
function unlisted(comment, words, wordsStart, place, length, sameSentence) {
  const wordsEnd = wordsStart + words.length
  const longestFirst = [...KINDS].sort((a, b) => b.length - a.length)
  const first = (text) => longestFirst.reduce((rest, kind) => rest.replaceAll(kind, ' '), text).split(/[\s,]+/).find((word) => word && !LISTED.includes(word))
  const between = !sameSentence ? '' : wordsEnd <= place ? comment.slice(wordsEnd, place) : place + length <= wordsStart ? comment.slice(place + length, wordsStart) : ''
  const word = first(between)
  if (word) return { word, where: 'between them' }
  const lead = first(comment.slice(sentenceStart(comment, wordsStart), wordsStart))
  if (lead) return { word: lead, where: 'before them in their sentence' }
}

// What is wrong with how the comment names the kinds of the entries, which
// gitleaks reports when reported is true and does not report otherwise: a kind
// the comment does not name, or names under a sentence that is not in claims,
// or that claims states says the opposite, or names under a claim with a word
// unlisted finds before its words or between them and the kind, or names
// before words in its sentence that say what a rule reports and are not in
// claims.
function misnamed(comment, entries, reported, claims = CLAIMS) {
  for (const claim of claims) {
    assert.ok(typeof claim.words === 'string' && claim.words !== '' && typeof claim.reported === 'boolean', `a claim states its words and, as reported, whether they say a value is reported: ${JSON.stringify(claim)}`)
    assert.ok(!claims.some((other) => other.words === claim.words && other.reported !== claim.reported), `two claims state the same words, as reported and as not reported: ${JSON.stringify(claim.words)}`)
  }
  for (const entry of entries) {
    assert.ok(typeof entry.id === 'string' && typeof entry.kind === 'string' && entry.kind !== '', `an entry states its rule and the words that name its kind: ${JSON.stringify(entry)}`)
  }
  const verbs = [...comment.matchAll(VERB)]
  const says = reported ? 'reports' : 'does not report'
  // The claim whose words hold verb, and where those words start. When the
  // words of several claims hold it, those that end nearest after it, and of
  // those the ones that start first, so the order of claims does not decide.
  const claimOf = (verb) => claims
    .flatMap((claim) => indexesOf(comment, claim.words).filter((at) => at <= verb.index && verb.index < at + claim.words.length).map((start) => ({ ...claim, start })))
    .sort((a, b) => a.start + a.words.length - (b.start + b.words.length) || a.start - b.start)[0]
  const around = (verb) => JSON.stringify(comment.slice(Math.max(0, verb.index - 60), verb.index + verb[0].length))
  const problems = []
  for (const { id, kind } of entries) {
    const places = placesOf(comment, kind)
    if (places.length === 0) problems.push(`the comment in .gitleaks.toml does not name ${JSON.stringify(kind)}, a value ${id} ${says}`)
    for (const place of places) {
      const names = `the comment in .gitleaks.toml names ${JSON.stringify(kind)}, a value ${id} ${says}, under`
      const start = sentenceStart(comment, place)
      const end = sentenceEnd(comment, place + kind.length)
      const before = verbs.findLast((match) => match.index < place)
      const after = verbs.filter((match) => place + kind.length <= match.index && match.index < end)
      const verb = before && start <= before.index ? before : after[0] ?? before
      const claim = verb && claimOf(verb)
      const unread = claim && unlisted(comment, claim.words, claim.start, place, kind.length, start <= verb.index)
      if (!claim) {
        problems.push(`${names} ${verb ? around(verb) : 'no sentence that says what a rule reports'}, which is not a sentence in the claims`)
      } else if (unread) {
        problems.push(`${names} ${JSON.stringify(claim.words)}, with ${JSON.stringify(unread.word)} ${unread.where}, a word the checks do not read there`)
      } else if (claim.reported !== reported) {
        problems.push(`${names} ${JSON.stringify(claim.words)}`)
      }
      for (const later of after) {
        if (later !== verb && !claimOf(later)) problems.push(`${names} ${around(later)}, which is not a sentence in the claims`)
      }
    }
  }
  return problems
}

test('the comment in .gitleaks.toml names each kind of value in NOT_REPORTED under a sentence that says it is not reported', () => {
  assert.deepEqual(misnamed(configComment, NOT_REPORTED, false), [])
})

test('gitleaks does not report a line whose value its global allowlist matches', { skip }, () => {
  for (const { id, kind, line } of NOT_REPORTED) {
    const rule = rules.find((candidate) => candidate.id === id)
    assert.ok(rule && compile(rule.regex).test(line), `${id} does not match its line for ${JSON.stringify(kind)}`)
    const run = spawnSync('gitleaks', ['stdin', '--config', configPath, '--redact', '--verbose', '--no-color', '--no-banner'], { input: `${line}\n`, encoding: 'utf8' })
    assert.equal(run.status, 0, `gitleaks ${gitleaks.stdout.trim()} reports the ${id} line for ${JSON.stringify(kind)}:\n${run.stdout}\n${run.stderr}`)
  }
})

test('the comment in .gitleaks.toml names each value in REPORTED under a sentence that says it is reported', () => {
  assert.deepEqual(misnamed(configComment, REPORTED, true), [])
})

// The text with each a in it replaced by b, and each b by a.
function swap(text, a, b) {
  return text.split(a).map((part) => part.replaceAll(b, a)).join(b)
}

test('the comment checks fail when the comment names a value in REPORTED where it says a value is not reported, or the reverse', () => {
  const examples = (text) => swap(swap(text, '{{p<U+00E4>ssword}}', '{{<U+212A>eyname}}'), '${{secrets.P<U+00C4>SSWORD}}', '${{secrets.pa<U+017F><U+017F>word}}')
  const verbs = (text) => swap(text, 'reports', 'does not report')
  for (const edit of [examples, verbs, (text) => verbs(examples(text))]) {
    const comment = edit(configComment)
    assert.notEqual(comment, configComment)
    assert.notDeepEqual(misnamed(comment, NOT_REPORTED, false), [], comment)
    assert.notDeepEqual(misnamed(comment, REPORTED, true), [], comment)
  }
})

test('the comment checks fail when a sentence with any form of the verb names a value in NOT_REPORTED as reported', () => {
  const kind = '/tmp/pa<U+017F><U+017F>word'
  const sentences = [
    `${kind} is reported by database-password.`,
    `Both rules report ${kind}.`,
    `database-password reported ${kind} in a test run.`,
    `Reported by database-password: ${kind}.`,
    `database-password reports ${kind}.`,
  ]
  for (const sentence of sentences) {
    const comment = configComment.replace(`\${{secrets.pa<U+017F><U+017F>word}} or ${kind}.`, () => `\${{secrets.pa<U+017F><U+017F>word}}. ${sentence}`)
    assert.notEqual(comment, configComment)
    assert.ok(misnamed(comment, NOT_REPORTED, false).some((problem) => problem.includes(`names ${JSON.stringify(kind)}`)), comment)
  }
})

test('the comment checks fail when a sentence names a value in NOT_REPORTED as reported before it says the value is not reported', () => {
  const kind = '$<U+212A>EYNAME_X'
  assert.ok(configComment.includes(`${kind}, `))
  const comment = configComment.replace(`${kind}, `, '') + ` Note that database-password reports ${kind}, which the (?i) matches as k and s, so database-password does not report it.`
  assert.ok(misnamed(comment, NOT_REPORTED, false).some((problem) => problem.includes(`names ${JSON.stringify(kind)}`)), comment)
})

test('the comment checks pass when a sentence that names the values in REPORTED as reported says after them that other values are not reported', () => {
  const comment = configComment.replace('the Arabic-Indic digit three.', 'the Arabic-Indic digit three, and two letters which the (?i) matches as k and s, so database-password does not report them.')
  assert.notEqual(comment, configComment)
  // The words after the values that say what a rule reports, stated as a claim.
  // A sentence in CLAIMS ends with the same words, so there the words of both
  // claims hold the verb and end at the same place, and the checks read the
  // claim that starts first, whichever of the two is stated first: The stands
  // before the words of the other in that sentence.
  const added = { words: 'which the (?i) matches as k and s, so database-password does not report', reported: false }
  assert.ok(CLAIMS.some(({ words }) => words !== added.words && words.endsWith(added.words)))
  for (const claims of [[...CLAIMS, added], [added, ...CLAIMS]]) {
    assert.deepEqual(misnamed(comment, REPORTED, true, claims), [], comment)
    assert.deepEqual(misnamed(comment, NOT_REPORTED, false, claims), [], comment)
  }
})

test('the comment checks fail when words after a value in its sentence say what a rule reports and are not in CLAIMS, even after a claim and with the verb that agrees', () => {
  const kind = '/tmp/pa<U+017F><U+017F>word'
  const last = `\${{secrets.pa<U+017F><U+017F>word}} or ${kind}.`
  // Each case ends with the words the problem quotes, which end with the words
  // after the value that say what a rule reports.
  const cases = [
    [NOT_REPORTED, false, [kind], last, `\${{secrets.pa<U+017F><U+017F>word}}, but ${kind} is reported.`, `, but ${kind} is reported`],
    [NOT_REPORTED, false, [kind], last, `\${{secrets.pa<U+017F><U+017F>word}} or ${kind}, which it does not report either.`, ` or ${kind}, which it does not report`],
    [REPORTED, true, REPORTED.map((entry) => entry.kind), 'the Arabic-Indic digit three.', 'the Arabic-Indic digit three, though in fact it does not report them.', 'digit three, though in fact it does not report'],
  ]
  for (const [entries, reported, kinds, from, to, quoted] of cases) {
    const comment = configComment.replace(from, () => to)
    assert.notEqual(comment, configComment)
    const problems = misnamed(comment, entries, reported)
    for (const named of kinds) assert.ok(problems.some((problem) => problem.includes(`names ${JSON.stringify(named)}`) && problem.endsWith(`${quoted}", which is not a sentence in the claims`)), `${comment}\n${problems.join('\n')}`)
  }
})

test('the comment checks read the words after a value that say what a rule reports only up to the end of its sentence', () => {
  const comment = `${configComment} The secret scan reports a finding under the id of its rule.`
  assert.deepEqual(misnamed(comment, NOT_REPORTED, false), [], comment)
  assert.deepEqual(misnamed(comment, REPORTED, true), [], comment)
})

test('the comment checks name a value once when the only words in its sentence that say what a rule reports come after it and are not in CLAIMS', () => {
  const cases = [
    [NOT_REPORTED, false, '{{<U+212A>eyname}}', '{{<U+212A>eyname}} is one more value database-password does not report.'],
    [REPORTED, true, '{{p<U+00E4>ssword}}', '{{p<U+00E4>ssword}} is one more value database-password reports.'],
  ]
  for (const [entries, reported, kind, sentence] of cases) {
    const comment = `${configComment} ${sentence}`
    const problems = misnamed(comment, entries, reported)
    assert.equal(problems.length, 1, `${comment}\n${problems.join('\n')}`)
    assert.ok(problems[0].includes(`names ${JSON.stringify(kind)}`) && problems[0].endsWith('which is not a sentence in the claims'), problems[0])
  }
})

test('the comment checks read a sentence on past a `.` that a space does not follow, between a value and the verb', () => {
  const kind = '/tmp/pa<U+017F><U+017F>word'
  for (const between of ['as set in app.yml', 'like {{.Values.name}}']) {
    const comment = configComment.replace(`\${{secrets.pa<U+017F><U+017F>word}} or ${kind}.`, () => `\${{secrets.pa<U+017F><U+017F>word}}. ${kind}, ${between}, is reported by database-password.`)
    assert.notEqual(comment, configComment)
    assert.ok(misnamed(comment, NOT_REPORTED, false).some((problem) => problem.includes(`names ${JSON.stringify(kind)}`)), comment)
  }
})

test('the comment checks read a sentence in the claims as saying what is stated next to it, whatever words it says that with, for a value in NOT_REPORTED and for one in REPORTED', () => {
  const notReported = '/tmp/pa<U+017F><U+017F>word'
  const reported = '$P<U+00C4>SSWORD_X'
  // Each sentence with what it says of the value, true when it says the value
  // is reported. Some say not with a word that a list of such words once did
  // not hold, such as excluding, other than or seldom, and some hold a word
  // that such a list read as not, such as stopwords, nonce or exceptions.
  const sentences = [
    [true, (kind) => `${kind} is reported by database-password.`],
    [true, (kind) => `Both rules report ${kind}.`],
    [true, (kind) => `database-password reported ${kind} in a test run.`],
    [true, (kind) => `Reported by database-password: ${kind}.`],
    [true, (kind) => `database-password reports ${kind}.`],
    [true, (kind) => `${kind} is not unreported by database-password.`],
    [true, (kind) => `database-password reports ${kind}, which holds none of the stopwords.`],
    [true, (kind) => `With no exceptions, database-password reports ${kind}.`],
    [false, (kind) => `database-password does not report ${kind}.`],
    [false, (kind) => `Both rules do not report ${kind}.`],
    [false, (kind) => `${kind} is not reported by database-password.`],
    [false, (kind) => `${kind} is unreported by database-password.`],
    [false, (kind) => `database-password never reports ${kind}.`],
    [false, (kind) => `${kind} is Never reported by database-password.`],
    [false, (kind) => `database-password doesn't report ${kind}.`],
    [false, (kind) => `database-password doesn’t report ${kind}.`],
    [false, (kind) => `${kind} is no longer reported by database-password.`],
    [false, (kind) => `database-password cannot report ${kind}.`],
    [false, (kind) => `${kind} is not yet reported by database-password.`],
    [false, (kind) => `${kind} is never actually reported by database-password.`],
    [false, (kind) => `database-password fails to report ${kind}.`],
    [false, (kind) => `Neither rule reports ${kind}.`],
    [false, (kind) => `${kind} is non-reported by database-password.`],
    [false, (kind) => `Both rules report one of these, but not ${kind}.`],
    [false, (kind) => `database-password reports every value excluding ${kind}.`],
    [false, (kind) => `database-password reports values other than ${kind}.`],
    [false, (kind) => `database-password reports every value but ${kind}.`],
    [false, (kind) => `${kind} is omitted from what database-password reports.`],
    [false, (kind) => `database-password ignores ${kind} and reports the rest.`],
    [false, (kind) => `database-password seldom reports ${kind}.`],
    [false, (kind) => `${kind} is hardly ever reported by database-password.`],
    [false, (kind) => `${kind} is rarely reported by database-password.`],
    [false, (kind) => `database-password does not report ${kind} or the stopwords.`],
    [false, (kind) => `database-password does not report ${kind} in a nonce.`],
    [false, (kind) => `${kind} is one of the exceptions database-password does not report.`],
    [false, (kind) => `database-password does not report ${kind} through its non-capturing groups.`],
  ]
  const last = `\${{secrets.pa<U+017F><U+017F>word}} or ${notReported}.`
  for (const [says, sentence] of sentences) {
    const moved = configComment.replace(last, () => `\${{secrets.pa<U+017F><U+017F>word}}. ${sentence(notReported)}`)
    assert.notEqual(moved, configComment)
    const added = configComment.replace(last, () => `${last} ${sentence(reported)}`)
    assert.notEqual(added, configComment)
    assert.notDeepEqual(misnamed(added, REPORTED, true), [], added)
    // Stated as it reads, and then stated the other way: the statement, not the
    // words, decides.
    for (const stated of [says, !says]) {
      const movedProblems = misnamed(moved, NOT_REPORTED, false, [...CLAIMS, { words: sentence(notReported), reported: stated }])
      const notProblem = `the comment in .gitleaks.toml names ${JSON.stringify(notReported)}, a value database-password does not report, under ${JSON.stringify(sentence(notReported))}`
      assert.deepEqual(movedProblems, stated ? [notProblem] : [], moved)
      const addedProblems = misnamed(added, REPORTED, true, [...CLAIMS, { words: sentence(reported), reported: stated }])
      const problem = `the comment in .gitleaks.toml names ${JSON.stringify(reported)}, a value database-password reports, under ${JSON.stringify(sentence(reported))}`
      assert.deepEqual(addedProblems, stated ? [] : [problem], added)
    }
  }
})

test('the comment checks fail when a word other than `or` and `and` stands between the words of a claim and a value named under it in its sentence, outside every value', () => {
  // The words of a claim, and the last two values of the list after it, which
  // the comment joins with or.
  const lists = [
    [NOT_REPORTED, false, 'so database-password does not report', '${{secrets.pa<U+017F><U+017F>word}}', '/tmp/pa<U+017F><U+017F>word'],
    [REPORTED, true, 'so database-password reports values such as', '/Users/<U+00E4>pp/dbpassword', '/Users/app<U+0663>/dbpassword'],
  ]
  for (const [entries, reported, ending, previous, kind] of lists) {
    const words = CLAIMS.find((claim) => claim.words.endsWith(ending)).words
    const from = `${previous} or ${kind}`
    assert.ok(configComment.includes(from))
    for (const joiner of [', ', ' or ', ' and ', ', or ', ', and ']) {
      const comment = configComment.replace(from, () => `${previous}${joiner}${kind}`)
      assert.deepEqual(misnamed(comment, entries, reported), [], comment)
    }
    // Each joiner with the word the problem names.
    const joiners = [[', but ', 'but'], [', but not ', 'but'], [' excluding ', 'excluding'], [' other than ', 'other'], [', except ', 'except'], [' and not ', 'not'], [' or never ', 'never'], [' nor ', 'nor']]
    for (const [joiner, word] of joiners) {
      const comment = configComment.replace(from, () => `${previous}${joiner}${kind}`)
      const problem = `the comment in .gitleaks.toml names ${JSON.stringify(kind)}, a value database-password ${reported ? 'reports' : 'does not report'}, under ${JSON.stringify(words)}, with ${JSON.stringify(word)} between them, a word the checks do not read there`
      assert.deepEqual(misnamed(comment, entries, reported), [problem], comment)
    }
  }
})

test('the comment checks read the words between a value and the words of a claim after it in its sentence', () => {
  const kind = '/tmp/pa<U+017F><U+017F>word'
  const other = '{{<U+212A>eyname}}'
  const last = `\${{secrets.pa<U+017F><U+017F>word}} or ${kind}.`
  const claim = { words: 'are not reported by database-password', reported: false }
  const listed = configComment.replace(last, () => `\${{secrets.pa<U+017F><U+017F>word}}. ${kind} and ${other} are not reported by database-password.`)
  assert.deepEqual(misnamed(listed, NOT_REPORTED, false, [...CLAIMS, claim]), [], listed)
  const unlistedWord = configComment.replace(last, () => `\${{secrets.pa<U+017F><U+017F>word}}. ${kind}, unlike ${other}, are not reported by database-password.`)
  // unlike stands between kind and the claim, and before the claim in the
  // sentence that names other under it.
  const under = (named, where) => `the comment in .gitleaks.toml names ${JSON.stringify(named)}, a value database-password does not report, under ${JSON.stringify(claim.words)}, with "unlike" ${where}, a word the checks do not read there`
  assert.deepEqual(misnamed(unlistedWord, NOT_REPORTED, false, [...CLAIMS, claim]), [under(other, 'before them in their sentence'), under(kind, 'between them')], unlistedWord)
})

test('the comment checks fail when a word stands before the words of a claim in its sentence, also for a value named in a later sentence', () => {
  for (const lead of ['Never assume that', 'Nobody claims']) {
    for (const claim of CLAIMS) {
      const comment = configComment.replace(claim.words, () => `${lead} ${claim.words}`)
      assert.notEqual(comment, configComment)
      const problems = misnamed(comment, claim.reported ? REPORTED : NOT_REPORTED, claim.reported)
      assert.ok(problems.length > 0, comment)
      const word = lead.split(' ')[0]
      for (const problem of problems) assert.ok(problem.endsWith(`under ${JSON.stringify(claim.words)}, with ${JSON.stringify(word)} before them in their sentence, a word the checks do not read there`), problem)
    }
  }
  // A whole sentence written over, as the issue that asked for this check did.
  const sentence = 'api-key-generic and database-password do not report a value that allowlist matches.'
  assert.ok(configComment.includes(sentence))
  const rewritten = configComment.replace(/\S+ (?=api-key-generic and database-password do not report)/, 'Never assume that ')
  assert.notEqual(rewritten, configComment)
  assert.notDeepEqual(misnamed(rewritten, NOT_REPORTED, false), [], rewritten)
})

test('the comment checks refuse a claim that does not state, as reported, what it says of a value, or states the opposite of a claim with the same words', () => {
  for (const claim of ['database-password reports', { words: 'database-password reports' }, { words: 'database-password reports', reported: 'yes' }, { words: '', reported: true }]) {
    assert.throws(() => misnamed(configComment, REPORTED, true, [...CLAIMS, claim]), /^AssertionError.*a claim states its words/, JSON.stringify(claim))
  }
  const twin = { words: CLAIMS[0].words, reported: !CLAIMS[0].reported }
  assert.throws(() => misnamed(configComment, REPORTED, true, [...CLAIMS, twin]), /^AssertionError.*two claims state the same words/)
})

test('the comment checks refuse an entry with no kind and an empty string to find, and return', () => {
  assert.throws(() => misnamed(configComment, [{ id: 'database-password', kind: '' }, ...REPORTED], true), /^AssertionError.*an entry states its rule and the words that name its kind/)
  assert.throws(() => indexesOf(configComment, ''), /^AssertionError.*an empty string/)
})

test('the comment checks read a value under the claim whose words end nearest after the verb when the words of several claims hold it, whatever the order of the claims', () => {
  // A sentence with two claims, whose second claim holds the words of the first.
  const comment = `${configComment} database-password reports {{<U+212A>eyname}}, so database-password does not report {{p<U+00E4>ssword}}.`
  const first = { words: 'database-password reports', reported: true }
  const both = { words: 'database-password reports {{<U+212A>eyname}}, so database-password does not report', reported: false }
  const problem = `the comment in .gitleaks.toml names "{{<U+212A>eyname}}", a value database-password does not report, under ${JSON.stringify(first.words)}`
  const orders = [[...CLAIMS, first, both], [...CLAIMS, both, first]]
  for (const claims of orders) assert.deepEqual(misnamed(comment, NOT_REPORTED, false, claims), [problem], comment)
  assert.deepEqual(misnamed(comment, REPORTED, true, orders[0]), misnamed(comment, REPORTED, true, orders[1]), comment)
})

test('the comment checks read a sentence on past the `.` that ends e.g. or i.e., so a word before it stands before a claim', () => {
  const words = CLAIMS.find((claim) => claim.words.startsWith('So api-key-generic and database-password')).words
  for (const abbreviation of ['e.g.', 'i.e.', 'E.g.']) {
    const comment = configComment.replace(words, () => `It is false, ${abbreviation} ${words}`)
    assert.notEqual(comment, configComment)
    const problems = misnamed(comment, NOT_REPORTED, false)
    assert.ok(problems.length > 0, comment)
    for (const problem of problems) assert.ok(problem.endsWith(`under ${JSON.stringify(words)}, with "It" before them in their sentence, a word the checks do not read there`), problem)
  }
})

test('the comment checks end a sentence at a `!` or `?` after e.g or i.e, and at the `.` after a longer word that ends with those letters, so a word before it does not stand before a claim', () => {
  const words = CLAIMS.find((claim) => claim.words.startsWith('So api-key-generic and database-password')).words
  for (const ending of ['e.g!', 'e.g?', 'i.e!', 'i.e?', 'page.g.', 'api.e.']) {
    const comment = configComment.replace(words, () => `It is as in ${ending} ${words}`)
    assert.notEqual(comment, configComment)
    assert.deepEqual(misnamed(comment, NOT_REPORTED, false), [], comment)
  }
})

test('the comment checks fail when the comment does not name a value in NOT_REPORTED or REPORTED', () => {
  for (const [entries, reported, kind] of [[NOT_REPORTED, false, '{{<U+212A>eyname}}'], [REPORTED, true, '{{p<U+00E4>ssword}}']]) {
    const comment = configComment.replaceAll(kind, '')
    assert.notEqual(comment, configComment)
    assert.ok(misnamed(comment, entries, reported).some((problem) => problem.includes(`does not name ${JSON.stringify(kind)}`)), comment)
  }
})

test('the comment checks fail when a sentence that is not in CLAIMS names a value, even with the verb that agrees with it', () => {
  const cases = [
    [NOT_REPORTED, false, '{{<U+212A>eyname}}', 'database-password also does not report {{<U+212A>eyname}}.'],
    [REPORTED, true, '{{p<U+00E4>ssword}}', 'database-password also reports {{p<U+00E4>ssword}}.'],
  ]
  for (const [entries, reported, kind, sentence] of cases) {
    const comment = `${configComment} ${sentence}`
    assert.ok(misnamed(comment, entries, reported).some((problem) => problem.includes(`names ${JSON.stringify(kind)}`) && problem.endsWith('which is not a sentence in the claims')), comment)
  }
})

test('the comment checks name the claims they are called with, not CLAIMS, when a sentence is not in them', () => {
  const problems = misnamed(configComment, REPORTED, true, CLAIMS.filter(({ words }) => !words.includes('reports values such as')))
  assert.equal(problems.length, REPORTED.length, problems.join('\n'))
  for (const problem of problems) assert.ok(problem.endsWith('which is not a sentence in the claims') && !problem.includes('CLAIMS'), problem)
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
