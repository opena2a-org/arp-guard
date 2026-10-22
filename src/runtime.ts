/**
 * The engine's AgentRuntimeProtection, with AI-layer capture: when
 * `aiLayer.prompt`, `aiLayer.mcp` or `aiLayer.a2a` is enabled with
 * `capture: true`, `start()` also installs the hooks in ./ai-capture, which
 * feed the traffic the agent sends, and the model replies it reads, to the
 * prompt, MCP and A2A interceptors, and `stop()` removes them. When the config
 * sets `proxy`, `start()` also starts the engine's ARPProxy on 127.0.0.1
 * (./proxy), and `stop()` stops it.
 */
import {
  AgentRuntimeProtection as EngineAgentRuntimeProtection,
  loadConfig,
  type AILayerConfig as EngineAILayerConfig,
  type ARPConfig as EngineARPConfig,
  type ARPProxy,
  type ProxyConfig,
} from '@opena2a/aim-sdk/arp';
import { AILayerCapture, runAsArpOwnWork } from './ai-capture';
import { LoopbackProxy } from './proxy';

/** AI-layer protection (prompt, MCP, A2A scanning), with capture settings. */
export interface AILayerConfig extends EngineAILayerConfig {
  prompt?: {
    enabled: boolean;
    /** `true` makes `start()` capture model API traffic (default: false). */
    capture?: boolean;
    /** Model API hosts whose traffic is scanned (default: DEFAULT_MODEL_API_HOSTS). */
    hosts?: string[];
  };
  mcp?: {
    enabled: boolean;
    allowedTools?: string[];
    /** `true` makes `start()` capture MCP tool calls (default: false). */
    capture?: boolean;
  };
  a2a?: {
    enabled: boolean;
    trustedAgents?: string[];
    /** `true` makes `start()` capture A2A messages (default: false). */
    capture?: boolean;
  };
}

export interface ARPConfig extends EngineARPConfig {
  aiLayer?: AILayerConfig;
  /**
   * An HTTP reverse proxy `start()` starts on 127.0.0.1 (default: none). It
   * scans what passes through it with the interceptors `aiLayer` enables.
   */
  proxy?: ProxyConfig;
}

export class AgentRuntimeProtection extends EngineAgentRuntimeProtection {
  private readonly aiCapture: AILayerCapture;
  private readonly loopbackProxy: LoopbackProxy | null;

  constructor(configOrPath?: ARPConfig | string) {
    // Resolved here as the engine resolves it, so capture reads the same config.
    const config: ARPConfig = typeof configOrPath === 'string' ? loadConfig(configOrPath) : configOrPath ?? loadConfig();
    super(config);
    this.aiCapture = new AILayerCapture(this.getEngine(), config);
    // The requests L2 makes, in `analyze` and in the batch flush, are ARP's own.
    if (this.aiCapture.isConfigured()) runAsArpOwnWork(this.getIntelligence(), ['analyze', 'flushBatch']);
    this.loopbackProxy = config.proxy ? new LoopbackProxy(this.getEngine(), config.proxy, config.aiLayer) : null;
  }

  /** Start all monitors, then the proxy when the config sets one, then AI-layer capture */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    await super.start();
    if (this.loopbackProxy) {
      try {
        await this.loopbackProxy.start();
      } catch (error) {
        await super.stop();
        throw error;
      }
      // Capture leaves a request the agent sends to the proxy to the proxy,
      // unless the proxy passes it to an upstream unscanned.
      this.aiCapture.leaveToProxy(this.loopbackProxy.get()?.getPort() ?? null, this.loopbackProxy.config);
    }
    await this.aiCapture.start();
  }

  /** Stop AI-layer capture, then the proxy, then all monitors, and flush logs */
  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    await this.aiCapture.stop();
    await this.loopbackProxy?.stop();
    await super.stop();
  }

  /** The proxy `start()` started, while it runs, or null; `getPort()` gives its port */
  getProxy(): ARPProxy | null {
    return this.loopbackProxy?.get() ?? null;
  }
}
