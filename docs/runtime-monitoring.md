# Runtime monitoring

The README's [Runtime monitoring](../README.md#runtime-monitoring) section starts the monitors and calls the prompt interceptor. This page holds how to call the MCP and A2A interceptors, which file operations the monitor reports, and how it sees process spawns.

## AI-layer interceptors

`start()` does not see the prompts, MCP tool calls or A2A messages the agent sends or receives: the AI-layer interceptors are scanners the agent calls. Setting `aiLayer.prompt`, `aiLayer.mcp` or `aiLayer.a2a` to `{ enabled: true }` adds an interceptor to `getStatus()` that nothing calls. Make your own on the monitor's event engine, start it, and call it where the agent sends and receives that traffic, as the README's example does.

Call `scanInput` on what the agent sends to a model and `scanOutput` on the reply. For MCP tool calls, `new MCPProtocolInterceptor(arp.getEngine(), allowedTools)` has `scanToolCall(toolName, args)`; for A2A messages, `new A2AProtocolInterceptor(arp.getEngine(), trustedAgents)` has `scanMessage(from, to, content)`. An interceptor scans nothing until its own `start()`. Each call returns the matches and emits an event for each one, which `arp.onEvent` handlers and the alert rules receive. `intelligence: { enabled: false }` keeps the README's example from sending events off the machine, as [Intelligence Stack](how-it-works.md#intelligence-stack) describes.

## File operations

File reads are not monitored by default. The filesystem monitor watches the working directory with `fs.watch`, which sees files change but never sees one read. A change can go unreported as well: on a loaded machine, `fs.watch` can drop the event for a new file and still report a file written after it. With `interceptors: { filesystem: { enabled: true } }` in the config, ARP also reports reads of a fixed list of sensitive paths (`.ssh`, `.aws`, `.env` and others) made by calling `readFile` or `readFileSync` on the CommonJS `fs` module object between `start()` and `stop()`. `require('fs')` returns that object, and an ES module gets it as the default import (`import fs from 'node:fs'`). A read is not reported when it goes through a reference to either function taken before `start()`, such as `const { readFileSync } = require('fs')`; through an ES module named or namespace import (`import { readFileSync } from 'node:fs'`, `import * as fs from 'node:fs'`) bound before `start()`, as a static import in the module that calls `start()` is; or through `fs.promises`, a stream or `fs.open`. A read of any other path is not reported either. Nor are two reads of a listed path: one of a path that starts with the path of ARP's data directory (`dataDir` in the config, by default `.opena2a/arp` under the working directory), which takes in the files under that directory and a path beside it such as `.opena2a/arp-old/.env`; and one made in a worker thread, which has an `fs` module object of its own.

## Process spawns

The process monitor reads the process table with `ps` every `monitors.process.intervalMs` milliseconds, 5000 by default, and reports a child process it finds on one poll and not on the one before. A child that starts and exits between two polls is on neither, so it is not reported.

With `interceptors: { process: { enabled: true } }` in the config, ARP also reports each call to `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync` or `fork` made on the CommonJS `child_process` module object between `start()` and `stop()`, when the call is made. `require('child_process')` returns that object. This example turns the process monitor off, so what it prints comes from the interceptor alone:

```bash
node -e "
const { AgentRuntimeProtection } = require('agent-runtime-protection');
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
