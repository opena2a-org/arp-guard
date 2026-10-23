/**
 * AI-layer capture: the hooks `start()` installs when `aiLayer.prompt`,
 * `aiLayer.mcp` or `aiLayer.a2a` is enabled with `capture: true`, so the
 * traffic the agent sends, and the model replies it reads, reach the
 * interceptors without the application calling them.
 *
 * - Requests made with the global `fetch`, and with `request` or `get` on the
 *   CommonJS `http` and `https` module objects. To a model API host
 *   (`aiLayer.prompt.hosts`, by default DEFAULT_MODEL_API_HOSTS) the request
 *   body goes to `scanInput` and the response body to `scanOutput`. To any
 *   host, a JSON-RPC `tools/call` body goes to `scanToolCall`, and an A2A
 *   `message/send`, `message/stream`, `tasks/send` or `tasks/sendSubscribe`
 *   body to `scanMessage`.
 * - Lines written to the standard input of a child started with `spawn` on the
 *   CommonJS `child_process` module object, which is how an MCP client talks to
 *   a stdio server: a JSON-RPC `tools/call` line goes to `scanToolCall`.
 *
 * Capture observes: it passes each request and response on as it got them,
 * reads a body from a copy or as the agent writes and reads it, and catches its
 * own errors. A body it cannot read without consuming it, or larger than
 * MAX_CAPTURE_BYTES, is not scanned. What an output pattern matches in a model
 * reply is masked in the event it reports.
 *
 * For a body it does not scan because it is larger than MAX_CAPTURE_BYTES, and
 * for a text the engine matched only the first ENGINE_SCAN_CHARACTERS of,
 * capture reports an `info` event with the reason and the lengths, and none of
 * the text.
 */
import http = require('http');
import https = require('https');
import net = require('net');
import childProcess = require('child_process');
import zlib = require('zlib');
import { AsyncLocalStorage } from 'async_hooks';
import { finished } from 'stream';
import {
  A2AProtocolInterceptor,
  MCPProtocolInterceptor,
  PromptInterceptor,
  scanText,
  type EventEngine,
  type MonitorType,
} from '@opena2a/aim-sdk/arp';

/**
 * The model API hosts whose traffic the prompt interceptor sees when
 * `aiLayer.prompt.hosts` is not set. An entry is a host name, `*.` before a
 * domain for any host under it, or either with `:port` for that port alone.
 */
export const DEFAULT_MODEL_API_HOSTS: readonly string[] = Object.freeze([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.com',
  'api.groq.com',
  'api.deepseek.com',
  'api.x.ai',
  'api.together.xyz',
  'api.fireworks.ai',
  'openrouter.ai',
  '*.openai.azure.com',
]);

/** Bodies, and stdio lines, larger than this many bytes are not scanned. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * The characters of a text the engine matches its patterns against: `scanText`
 * in `@opena2a/aim-sdk` 1.3.1 takes the first 65,536 and sets `truncated` in
 * its result when the text is longer.
 */
export const ENGINE_SCAN_CHARACTERS = 64 * 1024;

/** The part of the config capture reads. */
export interface CaptureConfig {
  agentName: string;
  aiLayer?: {
    prompt?: { enabled: boolean; capture?: boolean; hosts?: readonly string[] };
    mcp?: { enabled: boolean; capture?: boolean; allowedTools?: string[] };
    a2a?: { enabled: boolean; capture?: boolean };
  };
}

/** An entry of `proxy.upstreams`, as capture reads it. */
export interface ProxyUpstreamRoute {
  pathPrefix: string;
  target: string;
  protocol: string;
}

const A2A_METHODS = new Set(['message/send', 'message/stream', 'tasks/send', 'tasks/sendSubscribe']);

// The upstream protocols whose requests ARP's proxy scans. It passes a request
// to an upstream of any other protocol, such as `passthrough`, on unscanned.
const PROXY_SCANNED_PROTOCOLS = new Set(['openai-api', 'mcp-http', 'a2a']);

// Set while ARP does its own work, and in the callbacks that work schedules:
// a request made then is ARP's, not the agent's, and is not captured.
const arpOwnWork = new AsyncLocalStorage<true>();

/**
 * Runs each named method of `target` as ARP's own work. L2 sends an event,
 * with the text that matched, to a model API; captured, that request would
 * report the text again and send the report to L2 in turn.
 */
export function runAsArpOwnWork(target: object, methods: readonly string[]): void {
  const owner = target as Record<string, unknown>;
  for (const key of methods) {
    const method = owner[key];
    if (typeof method !== 'function') continue;
    owner[key] = function (this: unknown, ...args: unknown[]) {
      return arpOwnWork.run(true, () => (method as AnyFunction).apply(this, args));
    };
  }
}

const isArpOwnWork = (): boolean => arpOwnWork.getStore() === true;

// Set while a fetch call capture has taken runs, and in the callbacks it
// schedules: a fetch built on `http` and `https`, such as node-fetch, sends
// its request through their hooked functions, and the fetch hook already has
// that request and its reply.
const capturedFetch = new AsyncLocalStorage<true>();

/**
 * The engine, for the prompt interceptor capture makes: the text an output
 * pattern matched in a model reply is masked before the event reaches the
 * event log, the `onEvent` handlers and L2. That text is what the reply
 * leaked, a credential for OL-001 and personal data for OL-002. The event
 * keeps the pattern, its severity and its description.
 */
export function maskingReplyMatches(engine: EventEngine): EventEngine {
  const masking = Object.create(engine) as EventEngine;
  masking.emit = (event) => engine.emit(maskReplyMatch(event));
  return masking;
}

function maskReplyMatch(event: EngineEvent): EngineEvent {
  const data = event?.data;
  if (!isRecord(data) || data.direction !== 'output' || typeof data.matchedText !== 'string') return event;
  return { ...event, data: { ...data, matchedText: `[masked: ${data.matchedText.length} characters]` } };
}

const ASSISTANT_ROLES = new Set(['assistant', 'model']);
const INPUT_ROLES = new Set(['user', 'tool', 'function']);

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;
type Patch = { owner: Record<string, unknown>; key: string; original: AnyFunction; wrapper: AnyFunction };
// `atProxyHost`: a request to the host reaches a listener on 127.0.0.1, the
// address ARP's proxy listens on. `localhost`: the host is the name localhost,
// which the system's resolver reads, so a request to it can reach that
// listener or another one at the same port.
type Target = { hostname: string; port: string; origin: string; path: string; atProxyHost: boolean; localhost: boolean };
// The target capture scans a request as sent to, whether it is a model API
// host, and whether ARP's proxy passes the request on to it and scans the reply.
type Route = { target: Target; model: boolean; proxied: boolean };
type HostRule = { host: string; port: string | null; suffix: boolean };
type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
};
type ByteStream = { getReader(): ByteReader };
type NodeStream = { on(event: string, listener: (...args: unknown[]) => void): unknown; once(event: string, listener: (...args: unknown[]) => void): unknown };
type HeadersLike = { get(name: string): string | null };
type FetchResponse = { body: unknown; headers: HeadersLike; clone(): FetchResponse };
type EngineEvent = Parameters<EventEngine['emit']>[0];
// The bytes capture counted of a body larger than MAX_CAPTURE_BYTES, with
// `atLeast` set when it stopped counting before the end of the body.
type Over = { over: number; atLeast?: true };
// A body capture read whole, or the bytes it counted of one larger than
// MAX_CAPTURE_BYTES before it stopped.
type Read = { bytes: Buffer } | Over;
// The text of a request body capture scans, the bytes it counted of one it does
// not scan because it is larger than MAX_CAPTURE_BYTES, or null for a body it
// does not scan for another reason.
type Body = string | Over | null;

export class AILayerCapture {
  private readonly engine: EventEngine;
  private readonly agentName: string;
  private readonly prompt: PromptInterceptor | null;
  private readonly mcp: MCPProtocolInterceptor | null;
  private readonly a2a: A2AProtocolInterceptor | null;
  private readonly hosts: HostRule[];
  private patches: Patch[] = [];
  private active = false;
  // The port of ARP's proxy on the loopback address, and the config whose
  // `upstreams` route the requests the agent sends to it.
  private proxyPort: string | null = null;
  private proxyConfig: { upstreams?: readonly ProxyUpstreamRoute[] } | null = null;

  constructor(engine: EventEngine, config: CaptureConfig) {
    const al = config.aiLayer;
    this.engine = engine;
    this.agentName = config.agentName;
    // Off unless `capture: true`: capture runs the engine's patterns on the
    // agent's thread, in the call that sends a request or writes a line, and
    // for some texts their time grows faster than the length of the text.
    this.prompt = al?.prompt?.enabled && al.prompt.capture === true ? new PromptInterceptor(maskingReplyMatches(engine)) : null;
    this.mcp = al?.mcp?.enabled && al.mcp.capture === true ? new MCPProtocolInterceptor(engine, al.mcp.allowedTools) : null;
    // The agent is the sender of every message capture sees, so the trusted
    // agent list, which names the senders the agent accepts, is not applied.
    this.a2a = al?.a2a?.enabled && al.a2a.capture === true ? new A2AProtocolInterceptor(engine) : null;
    this.hosts = (al?.prompt?.hosts ?? DEFAULT_MODEL_API_HOSTS)
      .map(parseHostRule)
      .filter((rule): rule is HostRule => rule !== null);
  }

  /** True when the config turns capture on for prompts, MCP or A2A. */
  isConfigured(): boolean {
    return Boolean(this.prompt || this.mcp || this.a2a);
  }

  /**
   * Leaves a request to ARP's proxy, on 127.0.0.1 at `port`, to the proxy: one
   * to `port` at a host `reachesProxyHost` accepts. The proxy scans it, unless
   * `proxy.upstreams` routes it to an upstream whose requests the proxy does
   * not scan, such as a `passthrough` one, or to none. Capture scans a request
   * routed to such an upstream as sent to the upstream's `target`, and leaves
   * its reply to the proxy; it scans one routed to none as sent to the proxy's
   * host.
   */
  leaveToProxy(port: number | null, proxy: { upstreams?: readonly ProxyUpstreamRoute[] } | null = null): void {
    this.proxyPort = port === null ? null : String(port);
    this.proxyConfig = port === null ? null : proxy;
  }

  // True when a hooked call is the agent's traffic to capture.
  private capturing(): boolean {
    return this.active && !isArpOwnWork();
  }

  // How capture scans a request to `requested`: null when it does not, as when
  // it leaves the request to ARP's proxy. The proxy answers a request it routes
  // to no upstream with 404, passes it on to none and does not scan it, so
  // capture scans that request as sent to the proxy's host. To a host other
  // than a model API's, capture scans a request for the MCP and A2A
  // interceptors alone, so with neither on, it does not read the body, nor
  // report one larger than MAX_CAPTURE_BYTES.
  private route(requested: Target): Route | null {
    let target = requested;
    let proxied = false;
    const upstream =
      target.port === this.proxyPort && target.atProxyHost ? proxyUpstream(this.proxyConfig?.upstreams, target.path) : undefined;
    if (upstream) {
      if (PROXY_SCANNED_PROTOCOLS.has(upstream.protocol)) return null;
      target = fetchTarget(upstream.target) ?? target;
      proxied = true;
    }
    let model = this.isModelHost(target);
    // The system's resolver reads the name localhost, and need not answer
    // 127.0.0.1 for it first, so a request to the proxy's port at localhost can
    // reach another listener at that port, such as one on ::1. Capture leaves
    // neither the request nor its reply to the proxy, and scans the request as
    // one to a model API host as well when the proxy would pass it on to an
    // upstream whose `target` is one.
    if (!model && target.localhost && target.port === this.proxyPort) {
      const upstream = proxyUpstream(this.proxyConfig?.upstreams, target.path);
      const passedOnTo = upstream ? fetchTarget(upstream.target) : null;
      model = passedOnTo !== null && this.isModelHost(passedOnTo);
    }
    if (!model && !this.mcp && !this.a2a) return null;
    return { target, model, proxied };
  }

  async start(): Promise<void> {
    if (this.active || !this.isConfigured()) return;
    await Promise.all([this.prompt?.start(), this.mcp?.start(), this.a2a?.start()]);
    this.active = true;
    this.install();
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.uninstall();
    await Promise.all([this.prompt?.stop(), this.mcp?.stop(), this.a2a?.stop()]);
  }

  private install(): void {
    const self = this;
    const global = globalThis as unknown as Record<string, unknown>;
    if (typeof global.fetch === 'function') {
      this.patch(global, 'fetch', (original) =>
        function fetch(this: unknown, ...args: unknown[]) {
          return self.capturing() ? self.captureFetch(original, this, args) : original.apply(this, args);
        });
    }
    for (const [builtin, protocol] of [[http, 'http:'], [https, 'https:']] as const) {
      for (const key of ['request', 'get']) {
        this.patch(builtin as unknown as Record<string, unknown>, key, (original) =>
          function (this: unknown, ...args: unknown[]) {
            const req = original.apply(this, args);
            if (self.capturing() && capturedFetch.getStore() !== true) {
              safely(() => self.watchClientRequest(req as http.ClientRequest, args, protocol));
            }
            return req;
          });
      }
    }
    if (this.mcp) {
      this.patch(childProcess as unknown as Record<string, unknown>, 'spawn', (original) =>
        function (this: unknown, ...args: unknown[]) {
          const child = original.apply(this, args);
          if (self.capturing()) safely(() => self.watchChildStdin(child as childProcess.ChildProcess));
          return child;
        });
    }
    // ES module named and namespace imports of these built-ins keep the
    // original functions, as they do under the engine's interceptors:
    // `syncBuiltinESMExports()` syncs every built-in at once, so it would hand
    // the engine's `fs` and `child_process` hooks to those imports as well.
  }

  // A hook another library installed over this one stays in place, and this
  // one, no longer active, passes each call through to the function it wrapped.
  private uninstall(): void {
    for (const { owner, key, original, wrapper } of this.patches.reverse()) {
      if (owner[key] === wrapper) owner[key] = original;
    }
    this.patches = [];
  }

  private patch(owner: Record<string, unknown>, key: string, wrap: (original: AnyFunction) => AnyFunction): void {
    const original = owner[key];
    if (typeof original !== 'function') return;
    const wrapper = wrap(original as AnyFunction);
    owner[key] = wrapper;
    this.patches.push({ owner, key, original: original as AnyFunction, wrapper });
  }

  // The agent's fetch is called at once, with the arguments as given, as it
  // would be with no hook: it reads the URL and the options before the agent's
  // next statement can change them, and a body capture reads does not hold the
  // request back. Capture reads what it scans from the arguments before that
  // call, and the body of a Request from a copy, which it scans once whole.
  private captureFetch(original: AnyFunction, thisArg: unknown, args: unknown[]): unknown {
    let request: { target: Target; model: boolean; proxied: boolean; body: Body | Promise<Body> } | null = null;
    try {
      const requested = fetchTarget(args[0]);
      const route = requested && this.route(requested);
      if (route) request = { ...route, body: fetchBody(args[0], args[1], route.model) };
    } catch {
      // Capture never stands between the agent and its request.
    }
    if (request === null) return original.apply(thisArg, args);
    const result = capturedFetch.run(true, () => original.apply(thisArg, args));
    const { target, model, proxied, body } = request;
    if (body instanceof Promise) void body.then((read) => this.takeRequest(target, model, read));
    else this.takeRequest(target, model, body);
    // ARP's proxy scans the reply to a request it passes on.
    if (!model || proxied || !isPromiseLike(result)) return result;
    return result.then((response) => {
      safely(() => this.watchFetchResponse(target, response as FetchResponse));
      return response;
    });
  }

  // Scans a request body, or reports one that is too large to scan.
  private takeRequest(target: Target, model: boolean, body: Body): void {
    if (typeof body === 'string') safely(() => this.scanRequest(target, model, body));
    else if (body !== null) safely(() => this.reportOverLimit(target, model, 'request', body.over, undefined, body.atLeast));
  }

  private watchFetchResponse(target: Target, response: FetchResponse): void {
    if (!response || response.body === null || response.body === undefined) return;
    // A reply over the limit is not scanned, so it is not copied either.
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_CAPTURE_BYTES) return this.reportOverLimit(target, true, 'response', length);
    const copy = response.clone().body;
    // After clone(), `body` is the agent's branch of the body.
    void readCopy(copy, response.body).then((read) => {
      if (read === null) return;
      if ('over' in read) safely(() => this.reportOverLimit(target, true, 'response', read.over, undefined, read.atLeast));
      else safely(() => this.scanResponse(read.bytes.toString('utf8')));
    });
  }

  private watchClientRequest(req: http.ClientRequest, args: unknown[], protocol: string): void {
    const requested = requestTarget(args, protocol);
    const route = requested && this.route(requested);
    if (!route) return;
    const { target, model, proxied } = route;
    const self = this;

    if (!req.writableEnded) {
      const body = new BodyCollector(!model);
      const write = req.write as unknown as AnyFunction;
      const end = req.end as unknown as AnyFunction;
      let ended = false;
      req.write = function (this: unknown, ...writeArgs: unknown[]) {
        if (!ended && self.active) safely(() => body.add(writeArgs[0], writeArgs[1]));
        return write.apply(this, writeArgs);
      } as unknown as typeof req.write;
      req.end = function (this: unknown, ...endArgs: unknown[]) {
        if (!ended) {
          ended = true;
          if (self.active) {
            safely(() => {
              if (typeof endArgs[0] !== 'function') body.add(endArgs[0], endArgs[1]);
              const text = body.text();
              const over = body.over();
              if (text !== null) self.scanRequest(target, model, text);
              else if (over !== null) self.reportOverLimit(target, model, 'request', over);
            });
          }
        }
        return end.apply(this, endArgs);
      } as unknown as typeof req.end;
    }

    // `http` reads and discards a response no listener takes, which frees its
    // socket; it knows there is none when `emit('response')` returns false. So
    // the response is watched from inside `emit`, which returns what it would
    // with no hook, and is not scanned when it is discarded, as the agent never
    // reads it. ARP's proxy scans the reply to a request it passes on.
    if (model && !proxied) {
      const emit = req.emit as unknown as AnyFunction;
      req.emit = function (this: unknown, ...emitArgs: unknown[]) {
        if (emitArgs[0] !== 'response' || !self.active) return emit.apply(this, emitArgs);
        const watched = attempt(() => self.watchIncoming(target, emitArgs[1] as http.IncomingMessage));
        const taken = emit.apply(this, emitArgs);
        if (!taken) watched?.ignore();
        return taken;
      } as unknown as typeof req.emit;
    }
  }

  // Observes the chunks the agent reads from the response, through `emit`, so
  // the stream keeps the mode and the pace the agent's own reads give it.
  private watchIncoming(target: Target, res: http.IncomingMessage): { ignore(): void } {
    const self = this;
    const body = new BodyCollector(false);
    const emit = res.emit as unknown as AnyFunction;
    let done = false;
    res.emit = function (this: unknown, ...emitArgs: unknown[]) {
      const [event, chunk] = emitArgs;
      if (!done) {
        if (event === 'data') {
          safely(() => body.add(chunk, res.readableEncoding ?? undefined));
        } else if (event === 'end') {
          done = true;
          if (self.active) {
            safely(() => {
              const over = body.over();
              if (over !== null) return self.reportOverLimit(target, true, 'response', over);
              const encoding = res.headers['content-encoding'];
              const text = decodeBody(body.bytes(), encoding);
              if (typeof text === 'string') self.scanResponse(text);
              else if (text === TOO_LARGE) self.reportOverLimit(target, true, 'response', body.size(), encoding);
            });
          }
        } else if (event === 'close' || event === 'error') {
          done = true;
        }
      }
      return emit.apply(this, emitArgs);
    } as unknown as typeof res.emit;
    return {
      ignore: () => {
        done = true;
      },
    };
  }

  // An MCP stdio client writes one JSON-RPC message per line. A line feed
  // byte never occurs inside a multi-byte UTF-8 sequence, so lines are cut on
  // bytes and each is decoded whole. A line larger than MAX_CAPTURE_BYTES is
  // counted, not kept, and reported when it starts as JSON.
  private watchChildStdin(child: childProcess.ChildProcess): void {
    const stdin = child?.stdin;
    if (!stdin) return;
    const self = this;
    let parts: Buffer[] = [];
    let size = 0;
    // The first character of the line other than white space.
    let first: string | null = null;
    const add = (bytes: Buffer): void => {
      if (first === null) first = firstNonSpace(bytes);
      size += bytes.length;
      if (size <= MAX_CAPTURE_BYTES) parts.push(bytes);
      else parts = [];
    };
    const endLine = (): void => {
      if (size > MAX_CAPTURE_BYTES) {
        if (first === '{' || first === '[') safely(() => self.reportOverLimit(null, false, 'request', size));
      } else if (parts.length > 0) {
        const line = Buffer.concat(parts).toString('utf8');
        safely(() => self.scanStdioLine(line));
      }
      parts = [];
      size = 0;
      first = null;
    };
    const take = (chunk: unknown, encoding: unknown): void => {
      let bytes = toBuffer(chunk, encoding);
      if (!bytes) return;
      for (;;) {
        const newline = bytes.indexOf(0x0a);
        if (newline === -1) return add(bytes);
        add(bytes.subarray(0, newline));
        endLine();
        bytes = bytes.subarray(newline + 1);
      }
    };
    const write = stdin.write as unknown as AnyFunction;
    const end = stdin.end as unknown as AnyFunction;
    let ending = false;
    stdin.write = function (this: unknown, ...writeArgs: unknown[]) {
      if (!ending && self.active) safely(() => take(writeArgs[0], writeArgs[1]));
      return write.apply(this, writeArgs);
    } as unknown as typeof stdin.write;
    stdin.end = function (this: unknown, ...endArgs: unknown[]) {
      if (!ending && self.active) {
        safely(() => {
          if (endArgs.length > 0 && typeof endArgs[0] !== 'function') take(endArgs[0], endArgs[1]);
          endLine();
        });
      }
      ending = true;
      return end.apply(this, endArgs);
    } as unknown as typeof stdin.end;
  }

  private isModelHost(target: Target): boolean {
    return this.prompt !== null && matchesHost(this.hosts, target);
  }

  private scanRequest(target: Target, model: boolean, text: string): void {
    if (!model && !text.includes('"jsonrpc"')) return;
    const body = parseJson(text);
    if (body === undefined) return;
    if (model && this.prompt) {
      for (const input of promptInputs(body)) {
        if (this.prompt.scanInput(input).truncated) this.reportTruncated('prompt', 'the input', input.length, { direction: 'input' });
      }
    }
    this.scanJsonRpc(body, target.origin);
  }

  private scanResponse(text: string): void {
    if (!this.prompt) return;
    const output = promptOutputs(text);
    if (output.trim() !== '' && this.prompt.scanOutput(output).truncated) {
      this.reportTruncated('prompt', 'the output', output.length, { direction: 'output' });
    }
  }

  private scanStdioLine(line: string): void {
    if (!line.includes('tools/call')) return;
    const message = parseJson(line);
    if (message !== undefined) this.scanJsonRpc(message, null);
  }

  private scanJsonRpc(body: unknown, to: string | null): void {
    for (const message of Array.isArray(body) ? body : [body]) {
      if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') continue;
      const params = message.params;
      if (this.mcp && message.method === 'tools/call' && isRecord(params) && typeof params.name === 'string') {
        const toolName = params.name;
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (this.mcp.scanToolCall(toolName, args).truncated) {
          this.reportTruncated('mcp-protocol', `the arguments of tool "${toolName}"`, argumentsLength(args), { toolName });
        }
      } else if (this.a2a && to !== null && A2A_METHODS.has(message.method)) {
        const text = a2aText(params);
        if (text.trim() === '') continue;
        this.a2a.scanMessage(this.agentName, to, text);
        // The result of `scanMessage` carries no `truncated`; `scanText` with
        // no patterns gives the one the engine's scans of the message had.
        if (scanText(text, []).truncated) {
          this.reportTruncated('a2a-protocol', `the message to ${to}`, text.length, { from: this.agentName, to });
        }
      }
    }
  }

  // A body capture does not scan because it is larger than MAX_CAPTURE_BYTES:
  // `bytes` is its Content-Length, or the bytes capture counted of it, before
  // decoding when `contentEncoding` is given. `atLeast` is set when capture
  // stopped counting before the end of the body, so `bytes` is not its size.
  // `target` is null for a line written to a child's standard input.
  private reportOverLimit(
    target: Target | null,
    model: boolean,
    direction: 'request' | 'response',
    bytes: number,
    contentEncoding?: string,
    atLeast = false,
  ): void {
    const source: MonitorType = model ? 'prompt' : this.mcp ? 'mcp-protocol' : 'a2a-protocol';
    const size = `${atLeast ? 'at least ' : ''}${bytes} bytes`;
    const what =
      target === null
        ? `A line of ${size} written to a child's standard input`
        : `A ${direction} body of ${size}${contentEncoding === undefined ? '' : ` in ${contentEncoding}`} ${direction === 'request' ? 'to' : 'from'} ${target.origin}`;
    const why = contentEncoding === undefined ? `larger than ${MAX_CAPTURE_BYTES} bytes` : `it decodes to more than ${MAX_CAPTURE_BYTES} bytes`;
    this.report(source, `${what} was not scanned: ${why}`, {
      reason: 'body-over-limit',
      direction,
      origin: target?.origin ?? null,
      bytes,
      limitBytes: MAX_CAPTURE_BYTES,
      ...(contentEncoding === undefined ? {} : { contentEncoding }),
    });
  }

  // A text the engine matched only the first ENGINE_SCAN_CHARACTERS of.
  private reportTruncated(source: MonitorType, what: string, contentLength: number, data: Record<string, unknown>): void {
    this.report(source, `Only the first ${ENGINE_SCAN_CHARACTERS} of the ${contentLength} characters of ${what} were scanned`, {
      reason: 'scan-truncated',
      ...data,
      contentLength,
      scannedLength: ENGINE_SCAN_CHARACTERS,
    });
  }

  // The event carries the reason and the lengths, and none of the text. It is
  // `normal`, at `info`, so no default rule matches it.
  private report(source: MonitorType, description: string, data: Record<string, unknown>): void {
    void this.engine.emit({ source, category: 'normal', severity: 'info', description, data }).catch(() => {});
  }
}

// Collects a body as it is written or read, up to MAX_CAPTURE_BYTES; past that
// it counts the bytes and keeps none. With `jsonOnly`, a body whose first
// character other than white space is not `{` or `[` is dropped at once, so a
// request that cannot carry JSON-RPC is not held.
class BodyCollector {
  private chunks: Buffer[] = [];
  private count = 0;
  private state: 'sniff' | 'collect' | 'over' | 'skip';

  constructor(jsonOnly: boolean) {
    this.state = jsonOnly ? 'sniff' : 'collect';
  }

  add(chunk: unknown, encoding?: unknown): void {
    if (this.state === 'skip' || chunk === undefined || chunk === null) return;
    if (this.state === 'over') {
      this.count += byteLength(chunk, encoding);
      return;
    }
    const bytes = toBuffer(chunk, encoding);
    if (!bytes) return this.skip();
    if (bytes.length === 0) return;
    if (this.state === 'sniff') {
      const first = firstNonSpace(bytes);
      if (first !== null && first !== '{' && first !== '[') return this.skip();
      if (first !== null) this.state = 'collect';
    }
    this.count += bytes.length;
    if (this.count > MAX_CAPTURE_BYTES) {
      // White space alone so far: no JSON in the part capture would scan.
      if (this.state === 'sniff') return this.skip();
      this.state = 'over';
      this.chunks = [];
      return;
    }
    this.chunks.push(bytes);
  }

  bytes(): Buffer | null {
    return this.state === 'skip' || this.state === 'over' || this.count === 0 ? null : Buffer.concat(this.chunks);
  }

  text(): string | null {
    return this.bytes()?.toString('utf8') ?? null;
  }

  /** The bytes counted. */
  size(): number {
    return this.count;
  }

  /** The bytes counted of a body larger than MAX_CAPTURE_BYTES, or null. */
  over(): number | null {
    return this.state === 'over' ? this.count : null;
  }

  private skip(): void {
    this.state = 'skip';
    this.chunks = [];
    this.count = 0;
  }
}

/**
 * The text of the turns a model request adds to the conversation: the user,
 * tool and function turns after the last assistant turn of `messages` (chat
 * completions, Messages, Ollama), `contents` (Gemini) or `input` (Responses),
 * and `prompt` or a string `input`. System and developer turns are the
 * application's own and are not taken, nor are the turns before the last
 * assistant turn, so a turn is not scanned again each time the conversation is
 * sent. Assistant turns at the end of a request are a prefill, text the model
 * continues its reply from: the last assistant turn is then the last one
 * before them, so the user turn a prefill follows is taken.
 */
export function promptInputs(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const texts: string[] = [];
  for (const key of ['messages', 'contents', 'input']) {
    const value = body[key];
    if (key === 'input' && typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) texts.push(...newTurnTexts(value));
  }
  collectText(Array.isArray(body.prompt) ? body.prompt.filter((p) => typeof p === 'string') : body.prompt, texts);
  return texts.filter((text) => text.trim() !== '');
}

function newTurnTexts(turns: unknown[]): string[] {
  let end = turns.length;
  while (end > 0 && isAssistantTurn(turns[end - 1])) end -= 1;
  let start = 0;
  for (let i = 0; i < end; i++) {
    const turn = turns[i];
    if (isAssistantTurn(turn) || (isRecord(turn) && turn.type === 'function_call')) start = i + 1;
  }
  const texts: string[] = [];
  for (const turn of turns.slice(start, end)) {
    if (typeof turn === 'string') {
      texts.push(turn);
    } else if (isRecord(turn) && ((typeof turn.role === 'string' && INPUT_ROLES.has(turn.role)) || turn.type === 'function_call_output')) {
      collectText(turn.content, texts);
      collectText(turn.parts, texts);
      collectText(turn.output, texts);
    }
  }
  return texts;
}

function isAssistantTurn(turn: unknown): boolean {
  return isRecord(turn) && typeof turn.role === 'string' && ASSISTANT_ROLES.has(turn.role);
}

/**
 * The text a model response carries, from a JSON body or from a stream of
 * server-sent events or JSON lines: chat completion choices and deltas,
 * Messages content and text deltas, Gemini candidates, Responses output and
 * text deltas, and Ollama messages and responses.
 */
export function promptOutputs(text: string): string {
  const whole = parseJson(text);
  if (whole !== undefined) {
    return Array.isArray(whole) ? whole.flatMap(outputTexts).join('') : outputTexts(whole).join('\n');
  }
  const pieces: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (!line.startsWith('{')) continue;
    const chunk = parseJson(line);
    if (chunk !== undefined) pieces.push(...outputTexts(chunk));
  }
  return pieces.join('');
}

function outputTexts(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const texts: string[] = [];
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!isRecord(choice)) continue;
      if (isRecord(choice.message)) collectText(choice.message.content, texts);
      if (isRecord(choice.delta)) collectText(choice.delta.content, texts);
      if (typeof choice.text === 'string') texts.push(choice.text);
    }
  }
  if (body.type === 'message') collectText(body.content, texts);
  if (body.type === 'content_block_delta' && isRecord(body.delta) && typeof body.delta.text === 'string') {
    texts.push(body.delta.text);
  }
  if (Array.isArray(body.candidates)) {
    for (const candidate of body.candidates) {
      if (isRecord(candidate) && isRecord(candidate.content)) collectText(candidate.content.parts, texts);
    }
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (isRecord(item) && item.type === 'message') collectText(item.content, texts);
    }
  }
  if (body.type === 'response.output_text.delta' && typeof body.delta === 'string') texts.push(body.delta);
  if (isRecord(body.message) && body.message.role === 'assistant') collectText(body.message.content, texts);
  if (typeof body.response === 'string') texts.push(body.response);
  return texts;
}

// Strings, arrays of parts, and parts with `text` or nested `content` (a
// tool result), to a fixed depth.
function collectText(value: unknown, texts: string[], depth = 0): void {
  if (depth > 8 || value === undefined || value === null) return;
  if (typeof value === 'string') {
    texts.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, texts, depth + 1);
  } else if (isRecord(value)) {
    if (typeof value.text === 'string') texts.push(value.text);
    if (value.content !== undefined) collectText(value.content, texts, depth + 1);
  }
}

function a2aText(params: unknown): string {
  if (!isRecord(params) || !isRecord(params.message) || !Array.isArray(params.message.parts)) return '';
  const texts: string[] = [];
  for (const part of params.message.parts) {
    if (isRecord(part) && (part.kind === 'text' || part.type === 'text') && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('\n');
}

function parseHostRule(entry: string): HostRule | null {
  let value = String(entry).trim().toLowerCase();
  if (value === '') return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ?? null, suffix: false };
  let port: string | null = null;
  const colon = value.indexOf(':');
  if (colon !== -1 && colon === value.lastIndexOf(':')) {
    port = value.slice(colon + 1);
    value = value.slice(0, colon);
  }
  if (value.startsWith('*.')) return { host: value.slice(1), port, suffix: true };
  return { host: value, port, suffix: false };
}

function matchesHost(rules: HostRule[], target: Target): boolean {
  return rules.some((rule) => {
    if (rule.port !== null && rule.port !== target.port) return false;
    if (rule.suffix) return target.hostname.endsWith(rule.host) && target.hostname.length > rule.host.length;
    return target.hostname === rule.host;
  });
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

// `host` is the host the request connects to: the `hostname` or `host` option
// as given, or the host of a URL, with the brackets around an IPv6 address
// removed, as fetch and `http` remove them.
// `path` is the path and query the request line carries.
function makeTarget(protocol: string, host: string, port: string, path: string): Target {
  const hostname = host.replace(/^\[|\]$/g, '').toLowerCase();
  const shown = hostname.includes(':') ? `[${hostname}]` : hostname;
  return {
    hostname,
    port,
    origin: `${protocol}//${shown}${port === defaultPort(protocol) ? '' : `:${port}`}`,
    path,
    atProxyHost: reachesProxyHost(host.toLowerCase()),
    localhost: host.toLowerCase() === 'localhost',
  };
}

function urlHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

// The addresses, as the URL parser writes them, at which a request reaches a
// listener on 127.0.0.1: that address, and 0.0.0.0, a request to which
// reaches it on macOS and Linux, each also as an IPv4-mapped IPv6 address.
const PROXY_HOST_ADDRESSES = new Set(['127.0.0.1', '0.0.0.0', '[::ffff:7f00:1]', '[::ffff:0:0]']);

// True for an address `net.isIP` accepts, which Node connects to as written,
// in PROXY_HOST_ADDRESSES. Node passes a host `net.isIP` refuses to the
// system's resolver, which need not read it as the URL parser does: as the
// `hostname` option of `http.request` on macOS, 0177.0.0.1 does not reach a
// listener on 127.0.0.1, though the URL parser reads it as 127.0.0.1. Nor
// need the resolver answer 127.0.0.1 first for the name localhost: where it
// answers ::1 first, a request to localhost reaches a listener on ::1 at the
// port, when there is one, and not one on 127.0.0.1.
function reachesProxyHost(host: string): boolean {
  const family = net.isIP(host);
  if (family === 0) return false;
  const address = attempt(() => new URL(`http://${family === 6 ? `[${host}]` : host}/`).hostname);
  return address !== null && PROXY_HOST_ADDRESSES.has(address);
}

function fetchTarget(input: unknown): Target | null {
  let href: string;
  if (typeof input === 'string') href = input;
  else if (input instanceof URL) href = input.href;
  else if (isRecord(input) && typeof input.url === 'string') href = input.url;
  else return null;
  try {
    const url = new URL(href);
    return makeTarget(url.protocol, urlHost(url), url.port || defaultPort(url.protocol), url.pathname + url.search);
  } catch {
    return null;
  }
}

// The entry of `proxy.upstreams` ARP's proxy passes a request with this path
// to, found as the proxy finds it: of the entries whose `pathPrefix` the path
// starts with, one with the longest.
function proxyUpstream(upstreams: unknown, path: string): ProxyUpstreamRoute | undefined {
  if (!Array.isArray(upstreams)) return undefined;
  return ([...upstreams] as ProxyUpstreamRoute[])
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)
    .find((upstream) => path.startsWith(upstream.pathPrefix));
}

// The target of `http.request` / `https.request` / `get` arguments, read the
// way Node reads them: a URL or string, then options that override its parts.
function requestTarget(args: unknown[], fallbackProtocol: string): Target | null {
  let url: URL | undefined;
  let next = 0;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    try {
      url = new URL(String(args[0]));
    } catch {
      return null;
    }
    next = 1;
  }
  const options = isRecord(args[next]) ? (args[next] as Record<string, unknown>) : {};
  const protocol = typeof options.protocol === 'string' ? options.protocol : url?.protocol ?? fallbackProtocol;
  const hostname =
    (typeof options.hostname === 'string' && options.hostname) ||
    (typeof options.host === 'string' && options.host) ||
    (url && urlHost(url)) ||
    'localhost';
  const port =
    options.port !== undefined && options.port !== null && options.port !== ''
      ? String(options.port)
      : url?.port || defaultPort(protocol);
  const path = typeof options.path === 'string' ? options.path || '/' : url ? url.pathname + url.search : '/';
  return makeTarget(protocol, hostname, port, path);
}

// The body of a fetch request, read during the agent's call: from the options
// at once, when it is a string or bytes there; from a copy of the body of a
// Request the agent passes with no body in the options, as that copy is read.
function fetchBody(input: unknown, init: unknown, model: boolean): Body | Promise<Body> {
  const body = isRecord(init) ? init.body : undefined;
  if (body !== undefined && body !== null) return requestBody(toBuffer(body, undefined), model);
  if (!isRequestWithBody(input)) return null;
  if (!model && !/json/i.test(input.headers.get('content-type') ?? '')) return null;
  const length = Number(input.headers.get('content-length'));
  if (length > MAX_CAPTURE_BYTES) return { over: length };
  return readCopy(input.clone().body).then(
    (read) => (read === null || 'over' in read ? read : requestBody(read.bytes, model)),
    () => null,
  );
}

// To a host other than a model API's, a body that does not start as JSON
// cannot carry JSON-RPC, and is not scanned.
function requestBody(bytes: Buffer | null, model: boolean): Body {
  if (bytes === null || (!model && !startsAsJson(bytes))) return null;
  if (bytes.length > MAX_CAPTURE_BYTES) return { over: bytes.length };
  return bytes.toString('utf8');
}

function startsAsJson(bytes: Buffer): boolean {
  const first = firstNonSpace(bytes);
  return first === '{' || first === '[';
}

// A Request of fetch or of another implementation, such as node-fetch, with a
// body that is not read yet.
function isRequestWithBody(input: unknown): input is { headers: HeadersLike; body: unknown; bodyUsed: boolean; clone(): { body: unknown } } {
  if (!isRecord(input) || typeof input.clone !== 'function' || input.bodyUsed !== false) return false;
  const headers = input.headers as { get?: unknown } | null | undefined;
  return typeof headers?.get === 'function' && input.body !== null && input.body !== undefined;
}

// Reads the copy of a body that clone() gives, keeping at most
// MAX_CAPTURE_BYTES, and never rejects. A web stream, as fetch gives, is
// cancelled past that, which leaves the original to the agent, and also when
// the agent is done with `kept`, the branch it reads, before the body has
// arrived whole, which gives the bytes the copy holds then. A Node stream, as
// node-fetch gives, is read to its end: node-fetch pipes the body into the
// original and the copy alike, and the original moves on only as fast as the
// copy is read. Null when a read of the copy fails, or a Node stream closes
// before its end.
function readCopy(stream: unknown, kept?: unknown): Promise<Read | null> {
  if (isRecord(stream) && typeof stream.getReader === 'function') return readCapped(stream as unknown as ByteStream, kept);
  if (isRecord(stream) && typeof stream.on === 'function' && typeof stream.once === 'function') {
    return drainCapped(stream as unknown as NodeStream);
  }
  return Promise.resolve(null);
}

function drainCapped(stream: NodeStream): Promise<Read | null> {
  return new Promise((resolve) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += byteLength(chunk, undefined);
      if (chunks === null) return;
      const bytes = toBuffer(chunk, undefined);
      if (bytes && size <= MAX_CAPTURE_BYTES) chunks.push(bytes);
      else chunks = null;
    });
    stream.once('end', () => resolve(chunks ? { bytes: Buffer.concat(chunks) } : size > MAX_CAPTURE_BYTES ? { over: size } : null));
    stream.once('error', () => resolve(null));
    stream.once('close', () => resolve(null));
  });
}

// clone() tees a web stream, and the cancel of one branch of a tee completes
// only once the other branch is cancelled too, or the body ends or fails: the
// agent's cancel of `kept` would wait for the server to send the rest of the
// body, and the connection would stay open until then. So once `kept` is
// closed or has failed, a read of the copy that still waits for the body to go
// on is cancelled. That read then gives done, and the bytes the copy holds,
// which include every byte the agent read of `kept`, are scanned: the rest of
// the body does not arrive, as with no hook. When `kept` closes at the end of
// the body, the copy already holds the rest of it, and no read of it waits.
async function readCapped(stream: ByteStream, kept?: unknown): Promise<Read | null> {
  let reader: ByteReader;
  try {
    reader = stream.getReader();
  } catch {
    return null;
  }
  // `reading` is set while a read of the copy is in flight, and `stopped` once
  // capture cancels the copy because the agent is done with `kept`.
  let reading = false;
  let stopped = false;
  whenFinished(kept, () => {
    if (!reading) return;
    stopped = true;
    reader.cancel().catch(() => {});
  });
  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    reading = true;
    try {
      return await reader.read();
    } finally {
      reading = false;
    }
  };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_CAPTURE_BYTES) {
        // One read more tells whether the body ends with this chunk. When it
        // does not, or the copy is cancelled first, the rest is not read, so
        // `size` is a lower bound.
        const next = await read().catch(() => null);
        if (next?.done && !stopped) return { over: size };
        await reader.cancel().catch(() => {});
        return { over: size, atLeast: true };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by the cancel above.
    }
  }
  return { bytes: Buffer.concat(chunks) };
}

// Runs `run` once `body`, a web stream, is closed, at its end or by a cancel,
// or has failed. It runs a turn of the event loop later: a read of the copy
// that the bytes already received can complete completes in the promise jobs
// before that turn.
function whenFinished(body: unknown, run: () => void): void {
  if (body === undefined || body === null) return;
  safely(() => {
    finished(body as NodeJS.ReadableStream, () => {
      setImmediate(() => safely(run));
    });
  });
}

// What decodeBody gives for a body that decodes to more than MAX_CAPTURE_BYTES.
const TOO_LARGE = Symbol('too large');

// A response the agent read compressed, as `http` hands it over, is
// decompressed here, with the output held to MAX_CAPTURE_BYTES.
function decodeBody(bytes: Buffer | null, contentEncoding: string | undefined): string | typeof TOO_LARGE | null {
  if (!bytes) return null;
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  const limit = { maxOutputLength: MAX_CAPTURE_BYTES };
  try {
    if (encoding === '' || encoding === 'identity') return bytes.toString('utf8');
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(bytes, limit).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(bytes, limit).toString('utf8');
    if (encoding === 'deflate') {
      try {
        return zlib.inflateSync(bytes, limit).toString('utf8');
      } catch (error) {
        if (isTooLarge(error)) throw error;
        return zlib.inflateRawSync(bytes, limit).toString('utf8');
      }
    }
  } catch (error) {
    return isTooLarge(error) ? TOO_LARGE : null;
  }
  return null;
}

// The error zlib throws when its output would pass `maxOutputLength`.
function isTooLarge(error: unknown): boolean {
  return error instanceof RangeError && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

// The length of the text the engine's MCP interceptor scans for a tool call:
// the argument values joined with line feeds, as `flattenArgs` in
// `@opena2a/aim-sdk` 1.3.1 joins them. A string, number or boolean is one
// value, an array gives its strings and its objects, and an object is joined
// the same way, to a depth of 10.
function argumentsLength(args: object, depth = 0): number {
  if (depth > 10) return 0;
  const lengths: number[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === 'string') {
      lengths.push(value.length);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lengths.push(String(value).length);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') lengths.push(item.length);
        else if (typeof item === 'object' && item !== null) lengths.push(argumentsLength(item, depth + 1));
      }
    } else if (typeof value === 'object' && value !== null) {
      lengths.push(argumentsLength(value, depth + 1));
    }
  }
  return lengths.reduce((sum, length) => sum + length, 0) + Math.max(lengths.length - 1, 0);
}

// Strings, Buffers, typed arrays, DataViews and ArrayBuffers, copied, so a
// buffer the caller reuses after the write does not change what is scanned.
function toBuffer(chunk: unknown, encoding: unknown): Buffer | null {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
  }
  if (ArrayBuffer.isView(chunk)) return Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  return null;
}

// The number of bytes toBuffer gives for a chunk, without the copy.
function byteLength(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
  }
  if (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

function firstNonSpace(bytes: Buffer): string | null {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return String.fromCharCode(byte);
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // An error in capture never reaches the agent.
  }
}

function attempt<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
