# OASB benchmark

How to read an OASB result as coverage of this package. Back to the [README](../README.md).

## Benchmark

[OASB](https://github.com/opena2a-org/oasb) is a suite of 222 standardized test scenarios,
and it ships ARP as its reference adapter. On 2026-10-21, OASB 0.4.0 ran against this
package's engine, `@opena2a/aim-sdk` 1.3.1, the version this package's `package.json`
pins: 221 of the 222 scenarios passed, 0 failed and 1 was skipped. The skipped one is
`E2E-003`, the live network test the second caveat below describes.

The run used Node 20.20.2 on Linux (arm64), in the `node:20-bookworm` container image,
with `arp-guard` in the OASB checkout replaced by a build of this repository. To repeat
it, run `npm ci && npm run build` in a checkout of this repository, then these commands
in a checkout of OASB, with `/path/to/agent-runtime-protection` standing for the first
checkout:

```bash
git checkout v0.4.0
npm ci
npm pack /path/to/agent-runtime-protection /path/to/agent-runtime-protection/shim/arp-guard
npm install --no-save ./agent-runtime-protection-*.tgz ./arp-guard-*.tgz
npx vitest run src/atomic src/integration src/baseline src/e2e
```

Three caveats for reading an OASB result as coverage of this package, all verifiable from
a clean OASB checkout:

- Not every scenario maps to MITRE ATLAS. In OASB 0.4.0, 193 of the 222 sit in test
  files that carry an ATLAS reference: 165 in files that name a technique and 28 in
  files that name only a tactic. The other 29, in seven files, test baselines,
  correlation and the L0/L2 plumbing rather than an attack. To list those files:
  `find src/atomic src/integration src/baseline src/e2e -name '*.test.ts' -exec grep -L 'AML\.T' {} +`
- The polling network monitor, the one the README's [Runtime monitoring](../README.md#runtime-monitoring)
  example starts, has no running test. OASB skips `E2E-003` (live network detection)
  pending a reliable cross-platform check, and its five atomic network tests turn that
  monitor off and inject pre-classified events
  (`grep -c "network: false" src/atomic/network/*.test.ts`). Detection through the
  opt-in network interceptor is exercised, by `E2E-005`.
- `npm ci` in a checkout of OASB 0.4.0 does not install this package's engine. Its
  lockfile pins `arp-guard` 0.3.0, which loads `hackmyagent/arp` from `hackmyagent`
  0.23.8, a release that carries its own pre-migration copy of the runtime engine.
  The run above replaced `arp-guard` with this repository's build, as the commands
  show. Read a result as coverage of what this package ships today only from a run
  that does the same.
