# Changelog

This file starts at 0.4.0 and, for that release, lists the rename only.

## Unreleased

### Changed

- The README is shortened to the install line, the first call and its output, the runtime-monitoring and AI-layer scanning examples, and links. Its reference text moved, as written, to `docs/install.md` (what the release on npm delivers, and the rename from `arp-guard`), `docs/runtime-monitoring.md` (the MCP and A2A interceptors, and which file operations the monitor reports), `docs/how-it-works.md` (the intelligence stack, the architecture, and the pattern count) and `docs/benchmark.md` (OASB).

## 0.4.0

### Changed

- The package is renamed from `arp-guard` to `agent-runtime-protection`. Install `agent-runtime-protection` in place of `arp-guard` and change the import specifier. The rename changes no exported name and no API.

### Deprecated

- `arp-guard` is deprecated in favour of `agent-runtime-protection`. For the transition, `arp-guard` 0.4.0 is a shim that depends on `agent-runtime-protection` 0.4.0 and re-exports it, so an install or a peer range that names `arp-guard` keeps working.
