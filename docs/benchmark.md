# OASB benchmark

How to read an OASB result as coverage of this package. Back to the [README](../README.md).

## Benchmark

[OASB](https://github.com/opena2a-org/oasb) is a suite of 222 standardized test scenarios,
and it ships ARP as its reference adapter. No OASB run against this package's engine is
recorded here yet, so 222 is the number of scenarios, not the number that pass.

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
- The suite resolves ARP through an older `hackmyagent` that carries its own
  pre-migration copy of the runtime engine. Re-point it at `@opena2a/aim-sdk/arp`
  before reading the result as coverage of what this package ships today.
