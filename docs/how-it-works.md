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

`ALL_PATTERNS` is the pattern set the README's [AI-Layer Scanning](../README.md#ai-layer-scanning) example passes to `scanText`. It detects prompt injection, jailbreaks, data exfiltration, MCP exploitation, and A2A identity spoofing across 20 patterns in 7 categories.
