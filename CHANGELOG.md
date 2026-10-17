# Changelog

This file starts at 0.4.0 and, for that release, lists the rename only.

## Unreleased

### Changed

- The README is shortened to the install line, the first call and its output, the runtime-monitoring and AI-layer scanning examples, and links. Its reference text moved, as written, to `docs/install.md` (what the release on npm delivers, and the rename from `arp-guard`), `docs/runtime-monitoring.md` (the MCP and A2A interceptors, and which file operations the monitor reports), `docs/how-it-works.md` (the intelligence stack, the architecture, and the pattern count) and `docs/benchmark.md` (OASB).
- The README's longer paragraphs are split at sentence breaks into shorter ones. No text is added, removed or moved to another page.
- The README's Quick Start and AI-Layer Scanning examples pass `PATTERN_SETS.inputPatterns` to `scanText` in place of `ALL_PATTERNS`, and the Quick Start prints the same two lines. `ALL_PATTERNS` also holds the MCP and A2A patterns, which in ordinary prose report backtick spans, `../` and privilege words; the README now says which set is for which traffic.
- The README's AI-layer sentence says what the scanner is, 20 regular expressions in 7 categories, in place of a list of the attacks it detects.
- `docs/how-it-works.md` gives the figures measured against the DVAA attack corpus `attack-payloads.json`: how many of its entries `scanText` with the input set, the MCP interceptor and the A2A interceptor detect, and the command that measures them. `test/ai-layer-patterns.test.mjs` compares them with a fresh run when `ARP_DVAA_CORPUS` names the corpus file.
- The README no longer says process spawns are monitored without saying how. The process monitor polls `ps` every `monitors.process.intervalMs` milliseconds, 5000 by default, so a child process that starts and exits between two polls is not reported; the README and a new Process spawns section in `docs/runtime-monitoring.md` say so. That section shows the opt-in process interceptor (`interceptors: { process: { enabled: true } }`) reporting an `execSync` call when it is made, with the output of the example, and says that a reference to a `child_process` function taken before `start()` is not hooked.
- `docs/runtime-monitoring.md` has a Default rules section: the seven rules a config with no `rules` gets, what each matches, the action it takes, and what that comes to at each severity. It says that a `kill` triggered by a prompt, MCP or A2A event finds no process id and is logged as failed, as the one for PI-001 in the README's interceptor example is, and that `new AgentRuntimeProtection()` runs no rules unless the config file it finds sets them. The README says what the default rules do with that example's two matches and links the section.
- `docs/runtime-monitoring.md` has a Files ARP writes section: the data directory, which the constructor creates before `start()`, and the files ARP writes there; the behavioral twin's `events.jsonl` and `l1-escalations.jsonl` under `.opena2a/arp` in the home directory, with the fields of an `events.jsonl` line; and the two settings that turn the twin off. The README names both places and links the section.
- The File operations section of `docs/runtime-monitoring.md` says that the filesystem interceptor also reports writes made through `writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `mkdir` and `mkdirSync`, at `info`, at `high` for a path on its list of sensitive paths, and at `medium` for a path outside `interceptors.filesystem.allowedPaths` when that is set, and that it reports `unlink` and `unlinkSync` of a path on the list at `critical`.
- The README says that the exported `VERSION` is the version of the engine, `@opena2a/aim-sdk`, not of this package, and how to read this package's own version.
- `test/runtime-monitoring-page.test.mjs` checks what the Default rules, Files ARP writes and File operations sections say against probes run on the build.

## 0.4.0

### Changed

- The package is renamed from `arp-guard` to `agent-runtime-protection`. Install `agent-runtime-protection` in place of `arp-guard` and change the import specifier. The rename changes no exported name and no API.

### Deprecated

- `arp-guard` is deprecated in favour of `agent-runtime-protection`. For the transition, `arp-guard` 0.4.0 is a shim that depends on `agent-runtime-protection` 0.4.0 and re-exports it, so an install or a peer range that names `arp-guard` keeps working.
