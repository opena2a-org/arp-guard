# Runtime monitoring

The README's [Runtime monitoring](../README.md#runtime-monitoring) section starts the monitors and calls the prompt interceptor. This page holds how to call the MCP and A2A interceptors, which file operations the monitor reports, how it sees process spawns, what the default rules do with an event, and which files ARP writes.

## AI-layer interceptors

`start()` does not see the prompts, MCP tool calls or A2A messages the agent sends or receives: the AI-layer interceptors are scanners the agent calls. Setting `aiLayer.prompt`, `aiLayer.mcp` or `aiLayer.a2a` to `{ enabled: true }` adds an interceptor to `getStatus()` that nothing calls. Make your own on the monitor's event engine, start it, and call it where the agent sends and receives that traffic, as the README's example does.

Call `scanInput` on what the agent sends to a model and `scanOutput` on the reply. For MCP tool calls, `new MCPProtocolInterceptor(arp.getEngine(), allowedTools)` has `scanToolCall(toolName, args)`; for A2A messages, `new A2AProtocolInterceptor(arp.getEngine(), trustedAgents)` has `scanMessage(from, to, content)`. An interceptor scans nothing until its own `start()`. Each call returns the matches and emits an event for each one, which `arp.onEvent` handlers and the alert rules receive. `intelligence: { enabled: false }` keeps the README's example from sending events off the machine, as [Intelligence Stack](how-it-works.md#intelligence-stack) describes.

## File operations

File reads are not monitored by default. The filesystem monitor watches the working directory with `fs.watch`, which sees files change but never sees one read. A change can go unreported as well: on a loaded machine, `fs.watch` can drop the event for a new file and still report a file written after it. With `interceptors: { filesystem: { enabled: true } }` in the config, ARP also reports reads of a fixed list of sensitive paths (`.ssh`, `.aws`, `.env` and others) made by calling `readFile` or `readFileSync` on the CommonJS `fs` module object between `start()` and `stop()`. `require('fs')` returns that object, and an ES module gets it as the default import (`import fs from 'node:fs'`). A read is not reported when it goes through a reference to either function taken before `start()`, such as `const { readFileSync } = require('fs')`; through an ES module named or namespace import (`import { readFileSync } from 'node:fs'`, `import * as fs from 'node:fs'`) bound before `start()`, as a static import in the module that calls `start()` is; or through `fs.promises`, a stream or `fs.open`. A read of any other path is not reported either. Nor are two reads of a listed path: one of a path that starts with the path of ARP's data directory (`dataDir` in the config, by default `.opena2a/arp` under the working directory), which takes in the files under that directory and a path beside it such as `.opena2a/arp-old/.env`; and one made in a worker thread, which has an `fs` module object of its own.

The interceptor reports writes as well. A call to `writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `mkdir` or `mkdirSync` on that module object between `start()` and `stop()` is reported at `info`, as `Intercepted file operation: writeFileSync src/new-file.js`, so with the interceptor on, an agent's ordinary file writes are `info` events that `arp.onEvent` handlers receive. A write is reported at `high` instead when its path is on the list of sensitive paths, and at `medium` when the config sets `interceptors.filesystem.allowedPaths` and the path is outside those paths. A call to `unlink` or `unlinkSync` is reported only for a path on the list, at `critical`. A write is not reported when its path is under the data directory, when it goes through a reference to the function taken before `start()`, or when it goes through `fs.promises` or a stream.

## Process spawns

The process monitor reads the process table with `ps` every `monitors.process.intervalMs` milliseconds, 5000 by default, and reports a child process it finds on one poll and not on the one before. A child that starts and exits between two polls is on neither, so it is not reported.

With `interceptors: { process: { enabled: true } }` in the config, ARP also reports each call to `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync` or `fork` made on the CommonJS `child_process` module object between `start()` and `stop()`, when the call is made. `require('child_process')` returns that object. This example turns the process monitor off, so what it prints comes from the interceptor alone:

```bash
node -e "
const { AgentRuntimeProtection } = require('arp-guard');
(async () => {
  const arp = new AgentRuntimeProtection({
    agentName: 'my-agent',
    intelligence: { enabled: false },
    monitors: { process: { enabled: false } },
    interceptors: { process: { enabled: true } },
  });
  arp.onEvent((e) => console.log(e.source, e.severity.padEnd(8), e.description));
  await arp.start();
  require('child_process').execSync('node --version');
  await arp.stop();
})();
"
```

```text
process info     Intercepted exec: node --version
```

A call is not reported when it goes through a reference to the function taken before `start()`, such as `const { execSync } = require('child_process')`: with that line before `start()` and `execSync('node --version')` in place of the call above, the example prints nothing. `intelligence: { enabled: false }` keeps the example from sending events off the machine, as [Intelligence Stack](how-it-works.md#intelligence-stack) describes.

## Default rules

When an event matches a rule, ARP takes the rule's action. A config with no `rules`, such as the ones the README's examples pass, gets these seven:

| Rule | Matches | Action |
|---|---|---|
| `critical-threat` | a `threat` at `critical` | `kill` |
| `high-violation` | a `violation` at `high` or `critical` | `alert` |
| `anomaly-burst` | an `anomaly` that is at least the 10th event in the last 60 seconds, counting events of other sources and categories too | `alert` |
| `prompt-injection-detected` | a `threat` from `prompt` at `high` or `critical` | `alert` |
| `credential-leak-detected` | a `threat` from `prompt` whose `data.patternId` is `OL-001`, at any severity | `alert` |
| `mcp-exploitation-detected` | a `threat` from `mcp-protocol` at `high` or `critical` | `alert` |
| `a2a-spoofing-detected` | a `threat` from `a2a-protocol` at `high` or `critical` | `alert` |

By severity, that comes to this:

- At `critical`, a `threat` gets `kill`. One from the prompt, MCP or A2A interceptor matches a second rule and gets `alert` as well. A `violation` gets `alert`.
- At `high`, a `threat` from the prompt, MCP or A2A interceptor gets `alert`, and so does a `violation`. A `threat` from the process, network or filesystem monitor gets no action.
- At `medium`, `low` and `info`, only `anomaly-burst` and `credential-leak-detected` act.

`alert` calls the callback set with `arp.setAlertCallback()`. `kill` sends `SIGTERM` to the process whose id the event carries in `data.pid`. An event from the prompt, MCP or A2A interceptor carries no process id, so a `kill` it triggers stops nothing and is logged as failed. For PI-001 in the README's interceptor example, `enforcement.jsonl` in the data directory gets a `kill` line with `"success":false` and `"reason":"No PID to kill"`, beside an `alert` line for PI-001 and one for DE-001.

A config with a `rules` list runs that list in place of these seven, and `rules: []` runs none. `defaultConfig()` returns `rules: []`, and the constructor starts from it when it is given a path to a config file, or no config, so `new AgentRuntimeProtection()` runs no rules unless the config file it finds sets them.

## Files ARP writes

ARP writes in its data directory and, while the behavioral twin is on, in `.opena2a/arp` under the home directory.

The data directory is `dataDir` in the config, by default `.opena2a/arp` under the working directory, and the constructor creates it, before `start()`. ARP appends each event to `events.jsonl` there and each enforcement action to `enforcement.jsonl`. Once L2 has made a call, it also keeps the L2 budget there, in `budget.json`.

When `events.jsonl` or `enforcement.jsonl` in the data directory is larger than 50 MiB (52428800 bytes), ARP does not append the next line to it. It renames the file to its name followed by a dot and the time in milliseconds, as `Date.now()` returns it, and writes the line to a new file under the old name. The renamed files stay beside the new ones, so a data directory can also hold files such as `events.jsonl.1760000000000` and `enforcement.jsonl.1760000000000`.

The behavioral twin is on unless the config turns it off, so it is on for the README's first [Runtime monitoring](../README.md#runtime-monitoring) example. From `start()` on, it appends a line for each event to `.opena2a/arp/events.jsonl` under the home directory, wherever `dataDir` points. This is the line for a PI-001 match that is the first event after `start()`, with `...` for the values that change from run to run:

```text
{"agentId":"my-agent","sessionId":"...","sequenceNum":1,"eventType":"TOOL_CALL","capability":"unknown","toolName":null,"argHash":"...","timestampDelta":...,"wallClock":...,"responseSize":0,"responseCode":0,"l0Decision":"alert"}
```

`agentId` is the config's `agentName`, and `sessionId` is one id for each `AgentRuntimeProtection` instance. `argHash` is the first 16 hex characters of the SHA-256 hash of the event's `data` as JSON. `l0Decision` reads `alert` for a `threat` or a `violation` and for an event at `high` or `critical`, and `allow` for the others. After its first 100 events, the twin also appends the events it scores as anomalous, with their score, to `l1-escalations.jsonl` in the same directory.

To turn the twin off, and with it both files under the home directory, set `intelligence: { runtimeTwin: { enabled: false } }`, which keeps L2 on, or `intelligence: { enabled: false }`, which turns L2 off as well.
