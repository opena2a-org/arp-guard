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
 */
import http = require('http');
import https = require('https');
import childProcess = require('child_process');
import zlib = require('zlib');
import { AsyncLocalStorage } from 'async_hooks';
import {
  A2AProtocolInterceptor,
  MCPProtocolInterceptor,
  PromptInterceptor,
  type EventEngine,
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

/** The part of the config capture reads. */
export interface CaptureConfig {
  agentName: string;
  aiLayer?: {
    prompt?: { enabled: boolean; capture?: boolean; hosts?: readonly string[] };
    mcp?: { enabled: boolean; capture?: boolean; allowedTools?: string[] };
    a2a?: { enabled: boolean; capture?: boolean };
  };
}

const A2A_METHODS = new Set(['message/send', 'message/stream', 'tasks/send', 'tasks/sendSubscribe']);

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
type Target = { hostname: string; port: string; origin: string };
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

export class AILayerCapture {
  private readonly agentName: string;
  private readonly prompt: PromptInterceptor | null;
  private readonly mcp: MCPProtocolInterceptor | null;
  private readonly a2a: A2AProtocolInterceptor | null;
  private readonly hosts: HostRule[];
  private patches: Patch[] = [];
  private active = false;
  // The port of ARP's proxy on the loopback address, which scans the requests
  // the agent sends to it itself.
  private proxyPort: string | null = null;

  constructor(engine: EventEngine, config: CaptureConfig) {
    const al = config.aiLayer;
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

  /** Leaves a request to ARP's proxy, on 127.0.0.1 or localhost at `port`, to the proxy. */
  leaveToProxy(port: number | null): void {
    this.proxyPort = port === null ? null : String(port);
  }

  // True when a hooked call is the agent's traffic to capture.
  private capturing(): boolean {
    return this.active && !isArpOwnWork();
  }

  private isProxy(target: Target): boolean {
    return target.port === this.proxyPort && (target.hostname === '127.0.0.1' || target.hostname === 'localhost');
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
    let request: { target: Target; model: boolean; body: string | Promise<string | null> | null } | null = null;
    try {
      const target = fetchTarget(args[0]);
      if (target && !this.isProxy(target)) {
        const model = this.isModelHost(target);
        request = { target, model, body: fetchBody(args[0], args[1], model) };
      }
    } catch {
      // Capture never stands between the agent and its request.
    }
    if (request === null) return original.apply(thisArg, args);
    const result = capturedFetch.run(true, () => original.apply(thisArg, args));
    const { target, model, body } = request;
    if (typeof body === 'string') {
      safely(() => this.scanRequest(target, model, body));
    } else if (body !== null) {
      void body.then((text) => {
        if (text !== null) safely(() => this.scanRequest(target, model, text));
      });
    }
    if (!model || !isPromiseLike(result)) return result;
    return result.then((response) => {
      safely(() => this.watchFetchResponse(response as FetchResponse));
      return response;
    });
  }

  private watchFetchResponse(response: FetchResponse): void {
    if (!response || response.body === null || response.body === undefined) return;
    // A reply over the limit is not scanned, so it is not copied either.
    if (Number(response.headers.get('content-length')) > MAX_CAPTURE_BYTES) return;
    void readCopy(response.clone().body).then((bytes) => {
      if (bytes) safely(() => this.scanResponse(bytes.toString('utf8')));
    });
  }

  private watchClientRequest(req: http.ClientRequest, args: unknown[], protocol: string): void {
    const target = requestTarget(args, protocol);
    if (!target || this.isProxy(target)) return;
    const model = this.isModelHost(target);
    if (!model && !this.mcp && !this.a2a) return;
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
              if (text !== null) self.scanRequest(target, model, text);
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
    // reads it.
    if (model) {
      const emit = req.emit as unknown as AnyFunction;
      req.emit = function (this: unknown, ...emitArgs: unknown[]) {
        if (emitArgs[0] !== 'response' || !self.active) return emit.apply(this, emitArgs);
        const watched = attempt(() => self.watchIncoming(emitArgs[1] as http.IncomingMessage));
        const taken = emit.apply(this, emitArgs);
        if (!taken) watched?.ignore();
        return taken;
      } as unknown as typeof req.emit;
    }
  }

  // Observes the chunks the agent reads from the response, through `emit`, so
  // the stream keeps the mode and the pace the agent's own reads give it.
  private watchIncoming(res: http.IncomingMessage): { ignore(): void } {
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
              const text = decodeBody(body.bytes(), res.headers['content-encoding']);
              if (text !== null) self.scanResponse(text);
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
  // bytes and each is decoded whole.
  private watchChildStdin(child: childProcess.ChildProcess): void {
    const stdin = child?.stdin;
    if (!stdin) return;
    const self = this;
    let parts: Buffer[] = [];
    let size = 0;
    let discarding = false;
    const take = (chunk: unknown, encoding: unknown): void => {
      let bytes = toBuffer(chunk, encoding);
      if (!bytes) return;
      for (;;) {
        const newline = bytes.indexOf(0x0a);
        if (newline === -1) {
          if (discarding) return;
          parts.push(bytes);
          size += bytes.length;
          if (size > MAX_CAPTURE_BYTES) {
            parts = [];
            size = 0;
            discarding = true;
          }
          return;
        }
        if (!discarding && size + newline <= MAX_CAPTURE_BYTES) {
          parts.push(bytes.subarray(0, newline));
          const line = Buffer.concat(parts).toString('utf8');
          safely(() => self.scanStdioLine(line));
        }
        parts = [];
        size = 0;
        discarding = false;
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
          if (!discarding && parts.length > 0 && size <= MAX_CAPTURE_BYTES) self.scanStdioLine(Buffer.concat(parts).toString('utf8'));
          parts = [];
          size = 0;
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
      for (const input of promptInputs(body)) this.prompt.scanInput(input);
    }
    this.scanJsonRpc(body, target.origin);
  }

  private scanResponse(text: string): void {
    if (!this.prompt) return;
    const output = promptOutputs(text);
    if (output.trim() !== '') this.prompt.scanOutput(output);
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
        this.mcp.scanToolCall(params.name, isRecord(params.arguments) ? params.arguments : {});
      } else if (this.a2a && to !== null && A2A_METHODS.has(message.method)) {
        const text = a2aText(params);
        if (text.trim() !== '') this.a2a.scanMessage(this.agentName, to, text);
      }
    }
  }
}

// Collects a body as it is written or read, up to MAX_CAPTURE_BYTES. With
// `jsonOnly`, a body whose first character other than white space is not `{`
// or `[` is dropped at once, so a request that cannot carry JSON-RPC is not
// held.
class BodyCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  private state: 'sniff' | 'collect' | 'skip';

  constructor(jsonOnly: boolean) {
    this.state = jsonOnly ? 'sniff' : 'collect';
  }

  add(chunk: unknown, encoding?: unknown): void {
    if (this.state === 'skip' || chunk === undefined || chunk === null) return;
    const bytes = toBuffer(chunk, encoding);
    if (!bytes) return this.skip();
    if (bytes.length === 0) return;
    if (this.state === 'sniff') {
      const first = firstNonSpace(bytes);
      if (first !== null && first !== '{' && first !== '[') return this.skip();
      if (first !== null) this.state = 'collect';
    }
    this.size += bytes.length;
    if (this.size > MAX_CAPTURE_BYTES) return this.skip();
    this.chunks.push(bytes);
  }

  bytes(): Buffer | null {
    return this.state === 'skip' || this.size === 0 ? null : Buffer.concat(this.chunks);
  }

  text(): string | null {
    return this.bytes()?.toString('utf8') ?? null;
  }

  private skip(): void {
    this.state = 'skip';
    this.chunks = [];
    this.size = 0;
  }
}

/**
 * The text of the turns a model request adds to the conversation: the user,
 * tool and function turns after the last assistant turn of `messages` (chat
 * completions, Messages, Ollama), `contents` (Gemini) or `input` (Responses),
 * and `prompt` or a string `input`. System and developer turns are the
 * application's own and are not taken, nor are the turns before the last
 * assistant turn, so a turn is not scanned again each time the conversation is
 * sent.
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
  let start = 0;
  turns.forEach((turn, i) => {
    if (isRecord(turn) && ((typeof turn.role === 'string' && ASSISTANT_ROLES.has(turn.role)) || turn.type === 'function_call')) {
      start = i + 1;
    }
  });
  const texts: string[] = [];
  for (const turn of turns.slice(start)) {
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

function makeTarget(protocol: string, hostname: string, port: string): Target {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const shown = host.includes(':') ? `[${host}]` : host;
  return { hostname: host, port, origin: `${protocol}//${shown}${port === defaultPort(protocol) ? '' : `:${port}`}` };
}

function fetchTarget(input: unknown): Target | null {
  let href: string;
  if (typeof input === 'string') href = input;
  else if (input instanceof URL) href = input.href;
  else if (isRecord(input) && typeof input.url === 'string') href = input.url;
  else return null;
  try {
    const url = new URL(href);
    return makeTarget(url.protocol, url.hostname, url.port || defaultPort(url.protocol));
  } catch {
    return null;
  }
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
    url?.hostname ||
    'localhost';
  const port =
    options.port !== undefined && options.port !== null && options.port !== ''
      ? String(options.port)
      : url?.port || defaultPort(protocol);
  return makeTarget(protocol, hostname, port);
}

// The body of a fetch request, read during the agent's call: from the options
// at once, when it is a string or bytes there; from a copy of the body of a
// Request the agent passes with no body in the options, as that copy is read.
function fetchBody(input: unknown, init: unknown, model: boolean): string | Promise<string | null> | null {
  const body = isRecord(init) ? init.body : undefined;
  if (body !== undefined && body !== null) return requestText(toBuffer(body, undefined), model);
  if (!isRequestWithBody(input)) return null;
  if (!model && !/json/i.test(input.headers.get('content-type') ?? '')) return null;
  if (Number(input.headers.get('content-length')) > MAX_CAPTURE_BYTES) return null;
  return readCopy(input.clone().body).then(
    (bytes) => requestText(bytes, model),
    () => null,
  );
}

function requestText(bytes: Buffer | null, model: boolean): string | null {
  if (bytes === null || bytes.length > MAX_CAPTURE_BYTES) return null;
  const text = bytes.toString('utf8');
  if (!model && !/^\s*[[{]/.test(text)) return null;
  return text;
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
// cancelled past that, which leaves the original to the agent. A Node stream,
// as node-fetch gives, is read to its end: node-fetch pipes the body into the
// original and the copy alike, and the original moves on only as fast as the
// copy is read.
function readCopy(stream: unknown): Promise<Buffer | null> {
  if (isRecord(stream) && typeof stream.getReader === 'function') return readCapped(stream as unknown as ByteStream);
  if (isRecord(stream) && typeof stream.on === 'function' && typeof stream.once === 'function') {
    return drainCapped(stream as unknown as NodeStream);
  }
  return Promise.resolve(null);
}

function drainCapped(stream: NodeStream): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    stream.on('data', (chunk) => {
      if (chunks === null) return;
      const bytes = toBuffer(chunk, undefined);
      size += bytes?.length ?? 0;
      if (bytes && size <= MAX_CAPTURE_BYTES) chunks.push(bytes);
      else chunks = null;
    });
    stream.once('end', () => resolve(chunks && Buffer.concat(chunks)));
    stream.once('error', () => resolve(null));
    stream.once('close', () => resolve(null));
  });
}

async function readCapped(stream: ByteStream): Promise<Buffer | null> {
  let reader: ByteReader;
  try {
    reader = stream.getReader();
  } catch {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_CAPTURE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
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
  return Buffer.concat(chunks);
}

// A response the agent read compressed, as `http` hands it over, is
// decompressed here, with the output held to MAX_CAPTURE_BYTES.
function decodeBody(bytes: Buffer | null, contentEncoding: string | undefined): string | null {
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
      } catch {
        return zlib.inflateRawSync(bytes, limit).toString('utf8');
      }
    }
  } catch {
    return null;
  }
  return null;
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
