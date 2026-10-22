# Install

The [README](../README.md) installs `arp-guard`, the name the release on npm is published under. This page holds what the release on npm delivers, how it differs from `main`, and the rename from `arp-guard`.

## The Quick Start block on the published release

`main` prints the two lines the README's [Quick Start](../README.md#quick-start) block shows. A fresh install of the published 0.3.0 on 2026-10-17 printed the same two lines from the same block; it resolved `hackmyagent@0.33.2`, and a later install can resolve another release in 0.3.0's `>=0.11.0` range.

## What `npm install` delivers today

The [README](../README.md) describes `main`, which is not yet published. `agent-runtime-protection` is the package's name from 0.4.0, the release `main` becomes, and that name has no release on npm until 0.4.0 is published. The release on npm today is 0.3.0, published 2026-03-23 as `arp-guard` (see [Renamed from arp-guard](#renamed-from-arp-guard)), and it differs from `main` in four ways that matter.

- 0.3.0 depends on `hackmyagent` (`>=0.11.0`), not on `@opena2a/aim-sdk` directly. A fresh install on 2026-10-09 resolved `hackmyagent@0.33.2`, which pins `@opena2a/aim-sdk@1.3.1`, and that SDK's `arp` module is the engine 0.3.0 runs. An install that locked `hackmyagent@0.32.0` holds `@opena2a/aim-sdk@1.0.2` instead. The [Architecture](how-it-works.md#architecture) section describes `main`, not 0.3.0.
- The install brings the scanner and a model runtime with the engine. On 2026-10-22, `npm install arp-guard` in an empty project added 133 packages, and `du -sh node_modules` printed `340M`; a tarball packed from `main`, installed the same way, added 10 packages, none with an install script, and `du` printed `8.4M`. In that project, `npm ls hackmyagent @opena2a/aim-sdk onnxruntime-node` printed the chain: `arp-guard@0.3.0` depends on `hackmyagent@0.33.2`, the scanner, which depends on `@opena2a/aim-sdk@1.3.1`, the engine, and on `onnxruntime-node@1.30.0`, a model runtime. Of the 133 packages, `onnxruntime-node` alone has an install script, a `postinstall` that runs `node ./script/install`. npm 11.20.0 ran it, and after the install summary printed four lines that start with `npm warn install-scripts`, the first of them `npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:` and the next naming `onnxruntime-node@1.30.0 (postinstall: node ./script/install)`. The warning does not mean the script was skipped: `npm install arp-guard --loglevel=info` logs `npm info run onnxruntime-node@1.30.0 postinstall` and the script's exit code, 0. `npm install arp-guard --ignore-scripts` skips the script and adds the same 133 packages. With the script run and with it skipped, `require('arp-guard')` loaded and the README's [Quick Start](../README.md#quick-start) block printed its two lines.
- On 2026-10-22, the install placed six executables in `node_modules/.bin`: `aim-arp`, `canonicalize`, `hackmyagent`, `js-yaml`, `node-which` and `semver`. The tarball from `main` placed three of them, `aim-arp`, `canonicalize` and `js-yaml`, so `hackmyagent`, the scanner's CLI, `node-which` and `semver` came with 0.3.0 alone. `aim-arp` is the engine's CLI and `aim-arp telemetry` its consent CLI: `npx aim-arp telemetry --help`, run in the project, lists the subcommands `status`, `log`, `disclosure`, `opt-out`, `opt-in` and `purge`.
- On 2026-10-22, `require('arp-guard')` on 0.3.0 returned 41 names, and a build of `main` 87; the [changelog](../CHANGELOG.md) lists the 46 names `main` adds. The names 0.3.0 does not export include `writeOptOutMarker` and `clearOptOutMarker`, the engine's consent functions, so on 0.3.0 the telemetry opt-out is `npx aim-arp telemetry opt-out`, which writes the marker `writeOptOutMarker()` writes on `main`, and not a library call. This changes when 0.4.0 is published.

The L2 default is the same in 0.3.0 and on `main`, so it is not one of the four. In the engine 0.3.0 runs, as in the one `main` pins, L2 is on by default and its default adapter picks a destination from the environment: `ANTHROPIC_API_KEY` if set, otherwise `OPENAI_API_KEY`, otherwise a local Ollama at `localhost:11434`. On a machine that exports one of those keys, qualifying events, including the first 100 characters of a child process command line, are sent to that vendor, authenticated with your own key and billed to your own account. This is the default the [`@opena2a/aim-sdk` changelog](https://github.com/opena2a-org/agent-identity-management/blob/main/sdk/typescript/CHANGELOG.md) describes; it is in every published version of that SDK, 1.0.0 through 1.3.1, and it applies to the README's [Runtime monitoring](../README.md#runtime-monitoring) example as written, because a config with no `intelligence` block is read as on. The [Intelligence stack](how-it-works.md#intelligence-stack) section describes it.

To stop it on 0.3.0, pass `intelligence: { enabled: false }` in the constructor config:

```typescript
const arp = new AgentRuntimeProtection({
  agentName: 'my-agent',
  intelligence: { enabled: false },   // L2 off; no outbound call from the intelligence layer
});
```

This was measured to stop the outbound call on `@opena2a/aim-sdk@1.3.1`, the version a fresh install of 0.3.0 resolves; in 1.0.2, the gate it switches is the same code. It also switches off the in-process behavioral twin, which reads the same flag; L0 rules and the L1 statistical detection keep running. To keep L2 and the twin while sending nothing off the machine, set `intelligence: { adapter: 'ollama' }` instead, which sends L2 requests only to a local Ollama at `localhost:11434`.

The value must be the boolean `false`. A string (`"false"`, `"no"`, `"0"`) or the number `0` is not read as off: on the published engine it leaves L2 and the twin on, exactly as the default does, and a future engine release refuses such a value at construction.

To check that it was read as off, call `arp.getRuntimeTwin()`: on the published engine it returns `null` when the twin is off, and a twin that is on means L2 is on as well.

## Renamed from arp-guard

This package was published as `arp-guard` up to 0.3.0. On `main`, `package.json` names it `agent-runtime-protection` at 0.4.0, and `shim/arp-guard` holds an `arp-guard` 0.4.0 that re-exports it, so an import of `arp-guard` gets the same exports.

Neither name has a 0.4.0 on npm. On 2026-10-17, `npm view agent-runtime-protection version` failed with E404, and `npm view arp-guard versions` listed 0.3.0 alone. Install and import `arp-guard`, as the [README](../README.md#quick-start) does:

```bash
npm install arp-guard
```

What differs between 0.3.0 and `main` is in the section above.
