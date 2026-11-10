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

A later run measured `E2E-003` too, at a commit on OASB's `main` branch after 0.4.0. On
2026-11-10, OASB at commit `a21162132509` ran against the same engine, `@opena2a/aim-sdk`
1.3.1, in the `node:20-bookworm` image, with Node 20.20.2 on Linux (arm64) and `ss` on
PATH from Debian's `iproute2` package, which the image does not carry and the run
installed. Of its 223 scenarios, 223 passed, 0 failed and 0 were skipped, and `E2E-003`
passed. Before the tests, the `node_modules` of the OASB tree held a build of this
repository at commit `2defe1f1d7fb` as `arp-guard` 0.4.0 and `agent-runtime-protection`
0.4.0, and the `@opena2a/aim-sdk` that `agent-runtime-protection` resolves was 1.3.1. To
repeat it, run the commands above in that image with `git checkout v0.4.0` replaced by
these two lines:

```bash
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y iproute2
git checkout a2116213250934ce9ffe3e743ff41147e45547a3
```

Three caveats for reading an OASB result as coverage of this package, all verifiable from
a clean OASB checkout:

- Not every scenario maps to MITRE ATLAS. In OASB 0.4.0, 193 of the 222 sit in test
  files that carry an ATLAS reference: 165 in files that name a technique and 28 in
  files that name only a tactic. The other 29, in seven files, test baselines,
  correlation and the L0/L2 plumbing rather than an attack. To list those files:
  `find src/atomic src/integration src/baseline src/e2e -name '*.test.ts' -exec grep -L 'AML\.T' {} +`
- The polling network monitor, the one the README's [Runtime monitoring](../README.md#runtime-monitoring)
  example starts, is tested live by `E2E-003` (live network detection), which passed in
  the 2026-11-10 run above, on Linux with `ss`. macOS, where the test needs `lsof` in
  place of `ss`, is not measured by that run. OASB 0.4.0 skips `E2E-003`. At the commit
  of that run, the test skips as inconclusive where the tool it needs is not on PATH: in
  that image without `iproute2`, a run of the file alone printed
  `OASB: not measured (0 of 1 attack scenarios evaluated)` and exited 2. OASB's five
  atomic network tests still turn the monitor off
  (`grep -c "network: false" src/atomic/network/*.test.ts`), and none of them runs a
  poll: at the commit of that run, four inject pre-classified events, and `AT-NET-003`
  passes connection counts to the `checkConnectionBurst` method of a monitor it does not
  start, where in 0.4.0 it injected events as well. Detection through the opt-in network
  interceptor is exercised, by `E2E-005`.
- `npm ci` in a checkout of OASB 0.4.0 does not install this package's engine. Its
  lockfile pins `arp-guard` 0.3.0, which loads `hackmyagent/arp` from `hackmyagent`
  0.23.8, a release that carries its own pre-migration copy of the runtime engine.
  Both runs above replaced `arp-guard` with this repository's build, as the commands
  show. Read a result as coverage of what this package ships today only from a run
  that does the same.
