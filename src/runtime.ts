/**
 * The engine's AgentRuntimeProtection, with AI-layer capture: when
 * `aiLayer.prompt`, `aiLayer.mcp` or `aiLayer.a2a` is enabled, `start()` also
 * installs the hooks in ./ai-capture, which feed the traffic the agent sends,
 * and the model replies it reads, to the prompt, MCP and A2A interceptors, and
 * `stop()` removes them.
 */
import {
  AgentRuntimeProtection as EngineAgentRuntimeProtection,
  loadConfig,
  type AILayerConfig as EngineAILayerConfig,
  type ARPConfig as EngineARPConfig,
} from '@opena2a/aim-sdk/arp';
import { AILayerCapture, runAsArpOwnWork } from './ai-capture';

/** AI-layer protection (prompt, MCP, A2A scanning), with capture settings. */
export interface AILayerConfig extends EngineAILayerConfig {
  prompt?: {
    enabled: boolean;
    /** `false` keeps `start()` from capturing model API traffic (default: true). */
    capture?: boolean;
    /** Model API hosts whose traffic is scanned (default: DEFAULT_MODEL_API_HOSTS). */
    hosts?: string[];
  };
  mcp?: {
    enabled: boolean;
    allowedTools?: string[];
    /** `false` keeps `start()` from capturing MCP tool calls (default: true). */
    capture?: boolean;
  };
  a2a?: {
    enabled: boolean;
    trustedAgents?: string[];
    /** `false` keeps `start()` from capturing A2A messages (default: true). */
    capture?: boolean;
  };
}

export interface ARPConfig extends EngineARPConfig {
  aiLayer?: AILayerConfig;
}

export class AgentRuntimeProtection extends EngineAgentRuntimeProtection {
  private readonly aiCapture: AILayerCapture;

  constructor(configOrPath?: ARPConfig | string) {
    // Resolved here as the engine resolves it, so capture reads the same config.
    const config: ARPConfig = typeof configOrPath === 'string' ? loadConfig(configOrPath) : configOrPath ?? loadConfig();
    super(config);
    this.aiCapture = new AILayerCapture(this.getEngine(), config);
    // The requests L2 makes, in `analyze` and in the batch flush, are ARP's own.
    if (this.aiCapture.isConfigured()) runAsArpOwnWork(this.getIntelligence(), ['analyze', 'flushBatch']);
  }

  /** Start all monitors, then AI-layer capture */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    await super.start();
    await this.aiCapture.start();
  }

  /** Stop AI-layer capture, then all monitors, and flush logs */
  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    await this.aiCapture.stop();
    await super.stop();
  }
}
