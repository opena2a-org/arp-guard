> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [Secretless](https://github.com/opena2a-org/secretless-ai) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [ABG](https://github.com/opena2a-org/AI-BrowserGuard) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [ARP](https://github.com/opena2a-org/arp-guard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

# arp-guard — AI Runtime Protection

[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](./STATUS.md)
[![npm](https://img.shields.io/npm/v/arp-guard)](https://www.npmjs.com/package/arp-guard)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![OASB](https://img.shields.io/badge/OASB-reference%20adapter-blue)](https://github.com/opena2a-org/oasb)

EDR for AI agents. Monitors agent processes, network, filesystem and AI-layer traffic — prompts, MCP tool calls, A2A messages — then detects and enforces, across three layers: rule-based, statistical, and LLM-assisted.

## What `npm install` delivers today

This README describes `main`, which is not yet published. The version `npm install arp-guard` resolves today is 0.3.0, published 2026-03-23, and it differs from `main` in two ways that matter.

- 0.3.0 depends on `hackmyagent` (`>=0.11.0`), not on `@opena2a/aim-sdk` directly. A fresh install today resolves `hackmyagent@0.32.0`, which pins `@opena2a/aim-sdk@1.0.2`, and that SDK's `arp` module is the engine 0.3.0 runs. The Architecture section below describes `main`, not 0.3.0.
- In that engine, L2 is on by default and its default adapter picks a destination from the environment: `ANTHROPIC_API_KEY` if set, otherwise `OPENAI_API_KEY`, otherwise a local Ollama at `localhost:11434`. On a machine that exports one of those keys, qualifying events, including the first 100 characters of a child process command line, are sent to that vendor, authenticated with your own key and billed to your own account. This is the default the [`@opena2a/aim-sdk` changelog](https://github.com/opena2a-org/agent-identity-management/blob/main/sdk/typescript/CHANGELOG.md) describes; it is in every published version of that SDK, 1.0.0 through 1.3.1, and it applies to the Quick Start below as written, because a config with no `intelligence` block is read as on.

To stop it on 0.3.0, pass `intelligence: { enabled: false }` in the constructor config:

```typescript
const arp = new AgentRuntimeProtection({
  agentName: 'my-agent',
  intelligence: { enabled: false },   // L2 off; no outbound call from the intelligence layer
});
```

This was measured to stop the outbound call on `@opena2a/aim-sdk@1.3.1`; in the 1.0.2 that 0.3.0 resolves, the gate it switches is the same code. It also switches off the in-process behavioral twin, which reads the same flag; L0 rules and the L1 statistical detection keep running. To keep L2 and the twin while sending nothing off the machine, set `intelligence: { adapter: 'ollama' }` instead, which sends L2 requests only to a local Ollama at `localhost:11434`.

`main` currently pins an SDK that carries the same L2 default; the Intelligence stack section below describes it.

## Install

```bash
npm install arp-guard
```

## Quick Start

```typescript
import { AgentRuntimeProtection } from 'arp-guard';

const arp = new AgentRuntimeProtection({ agentName: 'my-agent' });
await arp.start();

// Agent runs normally — ARP monitors in background
// Process spawns, network connections, file access, prompts all monitored

await arp.stop();
```

## AI-Layer Scanning

```typescript
import { scanText, ALL_PATTERNS } from 'arp-guard';

const result = scanText(userInput, ALL_PATTERNS);
if (result.detected) {
  console.log('Threats found:', result.matches.map(m => m.pattern.id));
}
```

Detects prompt injection, jailbreaks, data exfiltration, MCP exploitation, and A2A identity spoofing across 20 patterns in 7 categories.

## Intelligence Stack

| Layer | Cost | Coverage |
|-------|------|----------|
| L0: Rules | Free | Pattern matching on every event |
| L1: Statistical | Free | Z-score anomaly detection |
| L2: LLM-Assisted | Budget-controlled | Micro-prompts for ambiguous events |

L2 runs only when L1 flags an event, its severity is at or above
`intelligence.minSeverityForLlm` (default `medium`), and the budget allows it. Default
budget: $5/month (`intelligence.budgetUsd`).

L2 is on by default, and the default adapter picks its destination from the environment:
`ANTHROPIC_API_KEY` if set, otherwise `OPENAI_API_KEY`, otherwise a local Ollama at
`localhost:11434`. On a machine that already exports a model key, qualifying events are
sent to that vendor with the agent context and the event, which for a process event
includes the command line. Set `intelligence.enabled: false` to run on L0 and L1 alone
with no outbound calls, or `intelligence.adapter: ollama` to keep inference local.

## Architecture

The runtime engine lives in the AIM agent-side SDK, at `@opena2a/aim-sdk/arp`. The
product boundary is by time: scan at rest with HackMyAgent, protect at runtime with ARP.

On `main`, this package re-exports that module directly, on an exact SDK pin, so installing it no longer pulls in the scanner or its model runtime. The published 0.3.0 does not do this yet: it resolves the engine through `hackmyagent`, as described at the top of this file. Importing `@opena2a/aim-sdk/arp` yourself gets you the same engine; use this package when you want ARP as a standalone dependency.

## Benchmark

[OASB](https://github.com/opena2a-org/oasb) is a suite of 222 standardized attack scenarios
mapped to MITRE ATLAS, and it ships ARP as its reference adapter.

Two caveats on that number, both verifiable from a clean checkout:

- OASB's own suite skips `E2E-003` (live network detection) pending a reliable
  cross-platform check, so network detection is not covered by the passing count.
- The suite resolves ARP through an older `hackmyagent` that carries its own
  pre-migration copy of the runtime engine. Re-point it at `@opena2a/aim-sdk/arp`
  before reading the result as coverage of what this package ships today.

## License

Apache-2.0
