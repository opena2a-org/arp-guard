// Guards the README's account of when the intelligence stack calls L2.
//
// The README once said L2 runs only when L1 flags an event. The engine has no
// such check: any event not classified `normal`, at or above
// `intelligence.minSeverityForLlm`, qualifies while the budget allows it, so a
// monitor's own classification sends an event to L2 before L1 has a baseline.
// On a machine with a model key exported, L2 is an outbound call, so the
// trigger a reader is told is a privacy claim, not a detail.
//
// These tests pin the trigger in the engine and the words in the README to each
// other: if the engine starts to require an L1 flag, the engine tests fail and
// the README has to change with it.
//
// Run against the BUILT output, because that is what ships. The adapter is a
// stand-in that records its calls, so nothing leaves the machine.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const arp = require('../dist/index.js')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

const ASSESSMENT = 'CONSISTENT: NO\nCONFIDENCE: 0.5\nREASONING: test\nACTION: ALERT'

// A coordinator with no history, whose adapter records the events it is asked
// about and the label each carried at that moment. `intelligence` is merged
// over the default config's intelligence settings.
function freshCoordinator(t, intelligence = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'arp-guard-l2-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const config = arp.defaultConfig()
  // A named adapter, so the constructor does not choose one from the
  // environment; the stand-in replaces it before any event is analyzed.
  config.intelligence = { ...config.intelligence, adapter: 'ollama', ...intelligence }
  const coordinator = new arp.IntelligenceCoordinator(config, dataDir)
  const calls = []
  let current = null
  coordinator.adapter = {
    name: 'stand-in',
    estimateCost: () => 0,
    assess: async (prompt) => {
      calls.push({ prompt, classifiedBy: current?.classifiedBy })
      return { content: ASSESSMENT, inputTokens: 1, outputTokens: 1 }
    },
  }
  t.after(() => coordinator.stop())
  return {
    calls,
    analyze: (event) => {
      current = event
      return coordinator.analyze(event)
    },
    stop: () => coordinator.stop(),
  }
}

function processEvent(category, severity) {
  return {
    id: `test-${category}-${severity}`,
    timestamp: new Date().toISOString(),
    source: 'process',
    category,
    severity,
    description: 'Suspicious binary executed: nc (PID 4242)',
    data: { pid: 4242, binary: 'nc' },
    classifiedBy: 'L0-rules',
  }
}

test('an event a monitor classified goes to L2 on a fresh coordinator, though L1 did not flag it', async (t) => {
  const { calls, analyze } = freshCoordinator(t, { enableBatching: false })
  const event = processEvent('violation', 'high')
  await analyze(event)
  assert.equal(calls.length, 1, 'the event was not sent to L2')
  // L1 labels an event it flags before L2 runs; the label is still the
  // monitor's when the adapter is asked, so L1 did not flag it.
  assert.equal(calls[0].classifiedBy, 'L0-rules', 'L1 flagged the event, so this does not show L2 runs without an L1 flag')
  assert.equal(event.classifiedBy, 'L2-llm')
})

test('with the default batching, the same event is queued and sent when the batch flushes', async (t) => {
  const { calls, analyze, stop } = freshCoordinator(t)
  await analyze(processEvent('violation', 'high'))
  assert.equal(calls.length, 0, 'a non-critical event was sent before its batch flushed')
  await stop()
  assert.equal(calls.length, 1, 'the queued event was not sent when the batch flushed')
})

test('an event classified normal does not go to L2, whatever its severity', async (t) => {
  const { calls, analyze } = freshCoordinator(t, { enableBatching: false })
  await analyze(processEvent('normal', 'critical'))
  assert.equal(calls.length, 0)
})

test('an event below intelligence.minSeverityForLlm does not go to L2', async (t) => {
  const byDefault = freshCoordinator(t, { enableBatching: false })
  await byDefault.analyze(processEvent('violation', 'low'))
  assert.equal(byDefault.calls.length, 0, 'a low event went to L2 under the default floor')

  const raised = freshCoordinator(t, { enableBatching: false, minSeverityForLlm: 'high' })
  await raised.analyze(processEvent('violation', 'medium'))
  assert.equal(raised.calls.length, 0, 'a medium event went to L2 with the floor raised to high')
  await raised.analyze(processEvent('violation', 'high'))
  assert.equal(raised.calls.length, 1, 'a high event did not go to L2 with the floor at high')
})

// The `## Intelligence Stack` section, with line breaks and runs of spaces read
// as one space, so a rewrap does not fail the check.
function intelligenceSection() {
  const start = readme.indexOf('\n## Intelligence Stack\n')
  assert.ok(start >= 0, 'the README has no Intelligence Stack section')
  const end = readme.indexOf('\n## ', start + 1)
  return readme.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ')
}

test('the README names the trigger the engine uses for L2, with its defaults', () => {
  const section = intelligenceSection()
  const { minSeverityForLlm, budgetUsd, maxCallsPerHour } = arp.defaultConfig().intelligence
  for (const claim of [
    'not classified `normal`',
    `\`intelligence.minSeverityForLlm\` (default \`${minSeverityForLlm}\`)`,
    'L1 does not have to flag the event',
    `$${budgetUsd}/month (\`intelligence.budgetUsd\`)`,
    `${maxCallsPerHour} calls per hour (\`intelligence.maxCallsPerHour\`)`,
  ]) {
    assert.ok(section.includes(claim), `the Intelligence Stack section does not say: ${claim}`)
  }
  assert.doesNotMatch(section, /only when L1 flags/, 'the README says L2 waits for an L1 flag, which the engine does not')
  assert.doesNotMatch(section, /ambiguous events/, 'the README says L2 is for ambiguous events, which the engine does not check')
})
