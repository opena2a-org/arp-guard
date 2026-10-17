// Guards what the README and docs/how-it-works.md say about the AI-layer
// patterns.
//
// The README's examples pass a pattern set to `scanText`. `ALL_PATTERNS`, the
// union of every category, holds the MCP and A2A patterns, which report a
// backtick span, a `../` or a phrase such as "grant permission" in ordinary
// prose: copied as written, the README's example reported two critical
// findings on the README itself. So the set is read out of the README's
// example and run over this repository's own pages, which are ordinary prose.
//
// docs/how-it-works.md gives figures measured against an attack corpus that is
// not part of this repository. Their arithmetic is checked on every run; the
// figures themselves are compared with a fresh run when ARP_DVAA_CORPUS names
// the corpus file, and the run prints each figure it measures.
//
// Run against the BUILT output, because that is what ships.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const arp = require('../dist/index.js')

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const readme = read('README.md')
const howItWorks = read('docs/how-it-works.md')

// Every page of prose this repository ships or links: the README, each page
// under docs/, the changelog and the license.
const PAGES = [
  'README.md',
  ...readdirSync(new URL('../docs/', import.meta.url))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${name}`),
  'CHANGELOG.md',
  'LICENSE',
]

// The `heading` section of `text`, up to the next `## ` heading outside a code
// block.
function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `no ${heading} section`)
  let fenced = false
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) fenced = !fenced
    else if (!fenced && lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

// The name the AI-Layer Scanning example passes to `scanText`, as written there.
function documentedSetName() {
  const match = /scanText\(userInput, ([\w$.]+)\)/.exec(section(readme, '## AI-Layer Scanning'))
  assert.ok(match, 'the AI-Layer Scanning example has no `scanText(userInput, <set>)` call')
  return match[1]
}

// The string the Quick Start scans, and the name of the set it passes.
function quickStartCall() {
  const match = /scanText\('([^']+)', ([\w$.]+)\)/.exec(section(readme, '## Quick Start'))
  assert.ok(match, "the Quick Start has no `scanText('<text>', <set>)` call")
  return { sample: match[1], setName: match[2] }
}

// `name`, a dotted path such as `PATTERN_SETS.inputPatterns`, read off the
// package's exports.
function resolve(name) {
  const set = name.split('.').reduce((value, key) => (value == null ? undefined : value[key]), arp)
  assert.ok(Array.isArray(set) && set.length > 0, `\`${name}\` is not a pattern set the package exports`)
  for (const pattern of set) assert.ok(pattern.pattern instanceof RegExp, `\`${name}\` holds an entry that is not a pattern`)
  return set
}

const describe = (matches) => matches.map((m) => `${m.pattern.id} ${JSON.stringify(m.matchedText)}`).join('; ')

test('the Quick Start passes the set the AI-Layer Scanning example passes', () => {
  assert.equal(quickStartCall().setName, documentedSetName())
})

test('the set the README passes to scanText holds no MCP or A2A pattern', () => {
  const name = documentedSetName()
  const protocol = resolve(name).filter((p) => p.category === 'mcp-exploitation' || p.category === 'a2a-attack')
  assert.deepEqual(protocol.map((p) => p.id), [], `\`${name}\` holds MCP or A2A patterns`)
})

// The Quick Start's string is an attack sample, there to be reported, and its
// output block quotes the parts of it that match. So the sample, and each part
// of it the set reports, is taken out of each page before the page is scanned;
// every other line is prose.
function withoutSample(text, set) {
  const { sample } = quickStartCall()
  const parts = arp.scanText(sample, set).matches.map((m) => m.matchedText)
  return [sample, ...parts.sort((a, b) => b.length - a.length)].reduce((rest, cut) => rest.split(cut).join(''), text)
}

for (const page of PAGES) {
  test(`${page} scans clean with the set the README passes, apart from the Quick Start's sample`, () => {
    const name = documentedSetName()
    const set = resolve(name)
    const result = arp.scanText(withoutSample(read(page), set), set)
    assert.equal(result.truncated, false, `${page} is longer than scanText scans`)
    assert.equal(result.detected, false, `${page} matches ${describe(result.matches)} with \`${name}\``)
  })
}

test("the sample taken out of each page is the Quick Start's string and the parts of it the set reports", () => {
  const set = resolve(documentedSetName())
  const { sample } = quickStartCall()
  assert.equal(withoutSample(`before ${sample} after`, set), 'before  after')
  assert.equal(withoutSample('a line about `scanText`', set), 'a line about `scanText`')
  for (const { matchedText } of arp.scanText(sample, set).matches) {
    assert.ok(sample.includes(matchedText), `${JSON.stringify(matchedText)} is not part of the sample`)
  }
})

const categoryNames = (patterns) => [...new Set(patterns.map((p) => p.category))]

test('the README gives the number of patterns and their categories as the engine does', () => {
  const text = section(readme, '## AI-Layer Scanning').replace(/\s+/g, ' ')
  const match = /(\d+) regular expressions in (\d+) categories: ([^.]+)\./.exec(text)
  assert.ok(match, 'the AI-Layer Scanning section gives no `<n> regular expressions in <m> categories: <names>.`')
  const [, count, categories, names] = match
  assert.equal(Number(count), arp.ALL_PATTERNS.length)
  assert.equal(Number(categories), categoryNames(arp.ALL_PATTERNS).length)
  const named = names.split(/, | and /).map((n) => n.toLowerCase().replace(/ /g, '-'))
  assert.deepEqual(named, categoryNames(arp.ALL_PATTERNS))
})

const patternsSection = () => section(howItWorks, '## AI-layer patterns').replace(/\s+/g, ' ')

test('docs/how-it-works.md gives the number of patterns and categories in ALL_PATTERNS', () => {
  const match = /`ALL_PATTERNS` holds (\d+) patterns in (\d+) categories/.exec(patternsSection())
  assert.ok(match, 'the AI-layer patterns section gives no `ALL_PATTERNS` holds <n> patterns in <m> categories')
  assert.equal(Number(match[1]), arp.ALL_PATTERNS.length)
  assert.equal(Number(match[2]), categoryNames(arp.ALL_PATTERNS).length)
})

test('docs/how-it-works.md names the set the README examples pass, where it says which set they pass and where it measures', () => {
  const text = patternsSection()
  const examples = /pass `([\w$.]+)` to `scanText`/.exec(text)
  assert.ok(examples, 'the AI-layer patterns section does not say which set the README examples pass to `scanText`')
  assert.equal(examples[1], documentedSetName())
  const measured = /\b[Ee]ach `payload` goes through `scanText` with `([\w$.]+)`/.exec(text)
  assert.ok(measured, 'the AI-layer patterns section does not say which set the payloads are scanned with')
  assert.equal(measured[1], documentedSetName())
})

// The figures docs/how-it-works.md states: the corpus version, its entry counts
// by field, one `detected of total` row per corpus category and field, and the
// total over the rows.
function pageFigures() {
  const text = section(howItWorks, '## AI-layer patterns')
  const flat = text.replace(/\s+/g, ' ')
  const version = /`attack-payloads\.json`, whose `version` field reads ([0-9]+(?:\.[0-9]+)*)/.exec(flat)
  assert.ok(version, 'the AI-layer patterns section does not name the corpus file and its version')
  const counts = /It holds (\d+) entries in (\d+) categories: (\d+) carry a `payload` \((\d+) strings and (\d+) objects[^)]*\), (\d+) a `toolCall`, (\d+) an `a2aMessage`, and (\d+) a `conversationHistory`/.exec(flat)
  assert.ok(counts, 'the AI-layer patterns section does not give the corpus entry counts by field')
  const [entries, categories, payload, strings, objects, toolCall, a2aMessage, conversationHistory] = counts.slice(1).map(Number)
  const rows = new Map()
  for (const [, category, field, detected, total] of text.matchAll(/^\| `([\w-]+)` \| `(payload|toolCall|a2aMessage)` \| (\d+) of (\d+) \|$/gm)) {
    rows.set(`${category} ${field}`, { detected: Number(detected), total: Number(total) })
  }
  const overall = /^\| All scanned entries \| \| (\d+) of (\d+) \|$/m.exec(text)
  assert.ok(rows.size > 0, 'the AI-layer patterns section gives no `detected of total` row')
  assert.ok(overall, 'the AI-layer patterns section gives no total row')
  return {
    version: version[1],
    counts: { entries, categories, payload, strings, objects, toolCall, a2aMessage, conversationHistory },
    rows,
    overall: { detected: Number(overall[1]), total: Number(overall[2]) },
  }
}

const sum = (rows, key, field) => [...rows].filter(([k]) => !field || k.endsWith(` ${field}`)).reduce((n, [, row]) => n + row[key], 0)

test('the figures in docs/how-it-works.md add up', () => {
  const { counts, rows, overall } = pageFigures()
  for (const [key, row] of rows) assert.ok(row.detected <= row.total, `${key}: ${row.detected} of ${row.total}`)
  assert.equal(overall.detected, sum(rows, 'detected'), 'the total row is not the sum of the detected column')
  assert.equal(overall.total, sum(rows, 'total'), 'the total row is not the sum of the rows')
  assert.equal(counts.strings + counts.objects, counts.payload, 'the `payload` strings and objects do not add up')
  assert.equal(sum(rows, 'total', 'payload'), counts.payload, 'the `payload` rows do not add up to the `payload` count')
  assert.equal(sum(rows, 'total', 'toolCall'), counts.toolCall, 'the `toolCall` rows do not add up to the `toolCall` count')
  assert.equal(sum(rows, 'total', 'a2aMessage'), counts.a2aMessage, 'the `a2aMessage` rows do not add up to the `a2aMessage` count')
  assert.equal(counts.payload + counts.toolCall + counts.a2aMessage + counts.conversationHistory, counts.entries, 'the fields do not add up to the entry count')
})

// Scans the corpus the way docs/how-it-works.md describes: each `payload`
// through `scanText` with `set`, a payload that is not a string as its JSON
// text; each `toolCall` through a started MCPProtocolInterceptor; each
// `a2aMessage` through a started A2AProtocolInterceptor, with the message's
// JSON text as the content. Neither interceptor has an allowlist, so only
// their patterns report.
async function measure(corpus, set) {
  const engine = new arp.EventEngine({})
  const mcp = new arp.MCPProtocolInterceptor(engine)
  const a2a = new arp.A2AProtocolInterceptor(engine)
  await mcp.start()
  await a2a.start()
  const counts = { entries: 0, categories: 0, payload: 0, strings: 0, objects: 0, toolCall: 0, a2aMessage: 0, conversationHistory: 0 }
  const rows = new Map()
  const unaccounted = []
  const count = (category, field, detected) => {
    const row = rows.get(`${category} ${field}`) ?? { detected: 0, total: 0 }
    row.total += 1
    if (detected) row.detected += 1
    rows.set(`${category} ${field}`, row)
    counts[field] += 1
  }
  try {
    for (const [category, { payloads }] of Object.entries(corpus.categories)) {
      counts.categories += 1
      for (const entry of payloads) {
        counts.entries += 1
        if (!['payload', 'toolCall', 'a2aMessage', 'conversationHistory'].some((field) => field in entry)) unaccounted.push(entry.id)
        if ('payload' in entry) {
          const text = typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload)
          counts[typeof entry.payload === 'string' ? 'strings' : 'objects'] += 1
          count(category, 'payload', arp.scanText(text, set).detected)
        }
        if ('toolCall' in entry) {
          count(category, 'toolCall', mcp.scanToolCall(entry.toolCall.tool, entry.toolCall.arguments ?? {}).detected)
        }
        if ('a2aMessage' in entry) {
          const message = entry.a2aMessage
          count(category, 'a2aMessage', a2a.scanMessage(String(message.fromAgent), String(message.toAgent), JSON.stringify(message)).detected)
        }
        if ('conversationHistory' in entry) counts.conversationHistory += 1
      }
    }
  } finally {
    await mcp.stop()
    await a2a.stop()
  }
  return { counts, rows, unaccounted }
}

const corpusPath = process.env.ARP_DVAA_CORPUS

test(
  'the corpus figures in docs/how-it-works.md are what a fresh run of the corpus measures',
  {
    skip: corpusPath
      ? false
      : 'ARP_DVAA_CORPUS is not set: set it to the path of the DVAA attack corpus attack-payloads.json to compare the figures in docs/how-it-works.md with a fresh run',
  },
  async (t) => {
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
    const page = pageFigures()
    const measured = await measure(corpus, resolve(documentedSetName()))
    const overall = { detected: sum(measured.rows, 'detected'), total: sum(measured.rows, 'total') }

    t.diagnostic(`corpus version ${corpus.version}`)
    t.diagnostic(`entries ${JSON.stringify(measured.counts)}`)
    for (const [key, row] of measured.rows) t.diagnostic(`${key} ${row.detected} of ${row.total}`)
    t.diagnostic(`all scanned entries ${overall.detected} of ${overall.total}`)

    assert.deepEqual(measured.unaccounted, [], 'corpus entries carry none of the fields the page accounts for')
    assert.equal(page.version, corpus.version, 'the page names another corpus version')
    assert.deepEqual(page.counts, measured.counts, 'the page gives other entry counts')
    assert.deepEqual(Object.fromEntries(page.rows), Object.fromEntries(measured.rows), 'the page gives other detected-of-total figures')
    assert.deepEqual(page.overall, overall, 'the page gives another total')
  },
)
