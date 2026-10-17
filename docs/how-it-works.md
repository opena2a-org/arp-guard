# How it works

When the intelligence stack sends an event to L2, where the runtime engine lives, and the patterns the AI-layer scanner matches. Back to the [README](../README.md).

## Intelligence Stack

| Layer | Cost | Coverage |
|-------|------|----------|
| L0: Rules | Free | Pattern matching on every event |
| L1: Statistical | Free | Z-score anomaly detection |
| L2: LLM-Assisted | Budget-controlled | Micro-prompts for events not classified `normal` |

An event qualifies for L2 when it is not classified `normal`, its severity is at or above
`intelligence.minSeverityForLlm` (default `medium`), and the budget allows it. L1 does not
have to flag the event: one a monitor already classified, such as `Suspicious binary
executed` (violation, high), qualifies from the first event, before L1 has a baseline.
Default budget: $5/month (`intelligence.budgetUsd`) and 20 calls per hour
(`intelligence.maxCallsPerHour`). To send fewer events, raise
`intelligence.minSeverityForLlm` to `high` or `critical`.

L2 is on by default, and the default adapter picks its destination from the environment:
`ANTHROPIC_API_KEY` if set, otherwise `OPENAI_API_KEY`, otherwise a local Ollama at
`localhost:11434`. On a machine that already exports a model key, qualifying events are
sent to that vendor with the agent context and the event, which for a process event
includes the command line. Set `intelligence.enabled: false` to run on L0 and L1 alone
with no outbound calls, or `intelligence.adapter: ollama` to keep inference local.

## Architecture

The runtime engine lives in the AIM agent-side SDK, at `@opena2a/aim-sdk/arp`. The
product boundary is by time: scan at rest with HackMyAgent, protect at runtime with ARP.

On `main`, this package re-exports that module directly, on an exact SDK pin, so installing it no longer pulls in the scanner or its model runtime. The published 0.3.0 does not do this yet: it resolves the engine through `hackmyagent`, as [What `npm install` delivers today](install.md#what-npm-install-delivers-today) describes. Importing `@opena2a/aim-sdk/arp` yourself gets you the same engine; use this package when you want ARP as a standalone dependency.

## AI-layer patterns

Both examples in the README, [Quick Start](../README.md#quick-start) and [AI-Layer Scanning](../README.md#ai-layer-scanning), pass `PATTERN_SETS.inputPatterns` to `scanText`: the prompt-injection, jailbreak, data-exfiltration and context-manipulation patterns, for what a user or another agent sends to a model. `PATTERN_SETS.mcpPatterns` is for MCP tool-call arguments and is the set `MCPProtocolInterceptor.scanToolCall` applies; `a2aPatterns` is for A2A messages, which `A2AProtocolInterceptor.scanMessage` scans with it and with the prompt-injection patterns; `outputPatterns` is for model replies. `ALL_PATTERNS` is the union of all of them, and in ordinary prose it reports backtick spans, `../` and privilege words.

`ALL_PATTERNS` holds 20 patterns in 7 categories.

### Measured against an attack corpus

These figures were measured against the DVAA attack corpus `attack-payloads.json`, whose `version` field reads 1.0.0. The corpus is not part of this repository. It holds 33 entries in 8 categories: 23 carry a `payload` (19 strings and 4 objects, scanned as their JSON text), 5 a `toolCall`, 4 an `a2aMessage`, and 1 a `conversationHistory`, which this measurement does not scan.

Each `payload` goes through `scanText` with `PATTERN_SETS.inputPatterns`, the set the README examples pass. Each `toolCall` goes through `scanToolCall(tool, arguments)` on a started `MCPProtocolInterceptor`, and each `a2aMessage` through `scanMessage(fromAgent, toAgent, content)` on a started `A2AProtocolInterceptor`, with the message's JSON text as the content. Neither interceptor is given a tool allowlist or a trusted-agent list, so only their patterns report. An entry counts as detected when the call returns `detected: true`.

| Corpus category | Field | Detected |
|---|---|---|
| `prompt-injection` | `payload` | 2 of 5 |
| `jailbreak` | `payload` | 2 of 4 |
| `data-exfiltration` | `payload` | 1 of 4 |
| `capability-abuse` | `payload` | 0 of 4 |
| `context-manipulation` | `payload` | 0 of 2 |
| `supply-chain` | `payload` | 0 of 4 |
| `mcp-exploitation` | `toolCall` | 3 of 5 |
| `a2a-attacks` | `a2aMessage` | 0 of 4 |
| All scanned entries | | 8 of 32 |

To run the measurement against a copy of the corpus, from a checkout of this repository:

```bash
npm ci && npm run build
ARP_DVAA_CORPUS=/path/to/attack-payloads.json node --test test/ai-layer-patterns.test.mjs
```

The test prints each figure it measures and fails when one differs from this table. Without `ARP_DVAA_CORPUS` it skips that comparison and checks only that the table adds up.
