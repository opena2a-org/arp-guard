# Install

The [README](../README.md) installs `arp-guard`, the name the release on npm is published under. This page holds what the release on npm delivers, how it differs from `main`, and the rename from `arp-guard`.

## The Quick Start block on the published release

`main` prints the two lines the README's [Quick Start](../README.md#quick-start) block shows. A fresh install of the published 0.3.0 on 2026-10-17 printed the same two lines from the same block; it resolved `hackmyagent@0.33.2`, and a later install can resolve another release in 0.3.0's `>=0.11.0` range.

## What `npm install` delivers today

The [README](../README.md) describes `main`, which is not yet published. `agent-runtime-protection` is the package's name from 0.4.0, the release `main` becomes, and that name has no release on npm until 0.4.0 is published. The release on npm today is 0.3.0, published 2026-03-23 as `arp-guard` (see [Renamed from arp-guard](#renamed-from-arp-guard)), and it differs from `main` in two ways that matter.

- 0.3.0 depends on `hackmyagent` (`>=0.11.0`), not on `@opena2a/aim-sdk` directly. A fresh install on 2026-10-09 resolved `hackmyagent@0.33.2`, which pins `@opena2a/aim-sdk@1.3.1`, and that SDK's `arp` module is the engine 0.3.0 runs. An install that locked `hackmyagent@0.32.0` holds `@opena2a/aim-sdk@1.0.2` instead. On 2026-10-18, `npm install arp-guard --ignore-scripts` in an empty project added 133 packages and 340 MiB to `node_modules`, among them `onnxruntime-node`, which has a `postinstall` script, while a tarball packed from `main`, installed the same way, added 10 packages and 8.3 MiB, none with an install script. The [Architecture](how-it-works.md#architecture) section describes `main`, not 0.3.0.
- In that engine, L2 is on by default and its default adapter picks a destination from the environment: `ANTHROPIC_API_KEY` if set, otherwise `OPENAI_API_KEY`, otherwise a local Ollama at `localhost:11434`. On a machine that exports one of those keys, qualifying events, including the first 100 characters of a child process command line, are sent to that vendor, authenticated with your own key and billed to your own account. This is the default the [`@opena2a/aim-sdk` changelog](https://github.com/opena2a-org/agent-identity-management/blob/main/sdk/typescript/CHANGELOG.md) describes; it is in every published version of that SDK, 1.0.0 through 1.3.1, and it applies to the README's [Runtime monitoring](../README.md#runtime-monitoring) example as written, because a config with no `intelligence` block is read as on.

To stop it on 0.3.0, pass `intelligence: { enabled: false }` in the constructor config:

```typescript
const arp = new AgentRuntimeProtection({
  agentName: 'my-agent',
  intelligence: { enabled: false },   // L2 off; no outbound call from the intelligence layer
});
```

This was measured to stop the outbound call on `@opena2a/aim-sdk@1.3.1`, the version a fresh install of 0.3.0 resolves; in 1.0.2, the gate it switches is the same code. It also switches off the in-process behavioral twin, which reads the same flag; L0 rules and the L1 statistical detection keep running. To keep L2 and the twin while sending nothing off the machine, set `intelligence: { adapter: 'ollama' }` instead, which sends L2 requests only to a local Ollama at `localhost:11434`.

The value must be the boolean `false`. A string (`"false"`, `"no"`, `"0"`) or the number `0` is not read as off: on the published engine it leaves L2 and the twin on, exactly as the default does, and a future engine release refuses such a value at construction.

`main` currently pins an SDK that carries the same L2 default; the [Intelligence stack](how-it-works.md#intelligence-stack) section describes it.

## Renamed from arp-guard

This package was published as `arp-guard` up to 0.3.0. On `main`, `package.json` names it `agent-runtime-protection` at 0.4.0, and `shim/arp-guard` holds an `arp-guard` 0.4.0 that re-exports it, so an import of `arp-guard` gets the same exports.

Neither name has a 0.4.0 on npm. On 2026-10-17, `npm view agent-runtime-protection version` failed with E404, and `npm view arp-guard versions` listed 0.3.0 alone. Install and import `arp-guard`, as the [README](../README.md#quick-start) does:

```bash
npm install arp-guard
```

What differs between 0.3.0 and `main` is in the section above.
