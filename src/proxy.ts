/**
 * The engine's ARPProxy, which `start()` starts when the config sets `proxy`:
 * an HTTP reverse proxy in the agent's process. It passes each request to the
 * upstream whose `pathPrefix` the request path starts with, and scans the
 * request and the reply, by the upstream's `protocol`, with the AI-layer
 * interceptors `aiLayer` enables.
 *
 * The engine's own `start()` listens on every interface; the proxy started
 * here listens on PROXY_HOST alone, and is stopped again if it is not.
 */
import type { Server } from 'http';
import {
  A2AProtocolInterceptor,
  ARPProxy,
  MCPProtocolInterceptor,
  PromptInterceptor,
  type ARPProxyDeps,
  type EventEngine,
  type ProxyConfig,
} from '@opena2a/aim-sdk/arp';
import { maskingReplyMatches, runAsArpOwnWork } from './ai-capture';

/** The address the proxy `start()` starts listens on. */
export const PROXY_HOST = '127.0.0.1';

/** The part of the config the proxy reads beside `proxy`. */
export interface ProxyAILayerConfig {
  prompt?: { enabled: boolean };
  mcp?: { enabled: boolean; allowedTools?: string[] };
  a2a?: { enabled: boolean; trustedAgents?: string[] };
}

type Interceptor = PromptInterceptor | MCPProtocolInterceptor | A2AProtocolInterceptor;
type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

export class LoopbackProxy {
  private readonly deps: ARPProxyDeps;
  private readonly interceptors: Interceptor[];
  private proxy: ARPProxy | null = null;

  constructor(
    engine: EventEngine,
    /** The `proxy` config the proxy runs with. */
    readonly config: ProxyConfig,
    aiLayer: ProxyAILayerConfig | undefined,
  ) {
    // What an output pattern matches in a reply is masked in the event, as it
    // is for capture: a credential for OL-001, personal data for OL-002.
    const prompt = aiLayer?.prompt?.enabled ? new PromptInterceptor(maskingReplyMatches(engine)) : undefined;
    const mcp = aiLayer?.mcp?.enabled ? new MCPProtocolInterceptor(engine, aiLayer.mcp.allowedTools) : undefined;
    const a2a = aiLayer?.a2a?.enabled ? new A2AProtocolInterceptor(engine, aiLayer.a2a.trustedAgents) : undefined;
    this.deps = { engine, promptInterceptor: prompt, mcpInterceptor: mcp, a2aInterceptor: a2a };
    this.interceptors = [prompt, mcp, a2a].filter((interceptor): interceptor is Interceptor => interceptor !== undefined);
  }

  /** The running proxy, or null. */
  get(): ARPProxy | null {
    return this.proxy;
  }

  async start(): Promise<void> {
    if (this.proxy) return;
    await Promise.all(this.interceptors.map((interceptor) => interceptor.start()));
    const proxy = new ARPProxy(this.config, this.deps);
    // The request the proxy sends to an upstream is ARP's own, so capture does
    // not scan it again.
    runAsArpOwnWork(proxy, ['handleRequest']);
    const bound: { server: Server | null } = { server: null };
    let failed: (error: Error) => void = () => {};
    const listenError = new Promise<never>((_, reject) => {
      failed = reject;
    });
    // The engine's `start()` assigns the server it creates to `server`, then
    // calls `listen(port, callback)` on it.
    Object.defineProperty(proxy, 'server', {
      configurable: true,
      enumerable: true,
      get: () => bound.server,
      set: (server: Server | null) => {
        bound.server = server;
        if (server) listenOnLoopback(server, (error) => failed(error));
      },
    });
    try {
      // The engine's `start()` does not settle when `listen` fails.
      await Promise.race([proxy.start(), listenError]);
      const address = bound.server?.address();
      if (!address || typeof address === 'string' || address.address !== PROXY_HOST) {
        await proxy.stop();
        throw new Error(`ARP proxy: not listening on ${PROXY_HOST}, so it is stopped`);
      }
    } catch (error) {
      await Promise.all(this.interceptors.map((interceptor) => interceptor.stop()));
      throw error;
    }
    this.proxy = proxy;
  }

  async stop(): Promise<void> {
    const proxy = this.proxy;
    if (!proxy) return;
    this.proxy = null;
    await proxy.stop();
    await Promise.all(this.interceptors.map((interceptor) => interceptor.stop()));
  }
}

// Makes `server.listen` listen on PROXY_HOST, whatever host it is given, and
// passes an error the server emits, such as EADDRINUSE, to `onError`.
function listenOnLoopback(server: Server, onError: (error: Error) => void): void {
  const listen = server.listen as unknown as AnyFunction;
  server.listen = function (this: unknown, port?: unknown, ...rest: unknown[]) {
    const callbacks = rest.filter((arg) => typeof arg === 'function');
    if (typeof port === 'object' && port !== null) return listen.call(this, { ...port, host: PROXY_HOST }, ...callbacks);
    return listen.call(this, port, PROXY_HOST, ...callbacks);
  } as unknown as Server['listen'];
  server.on('error', onError);
}
