/**
 * agent-runtime-protection — Agent Runtime Protection
 *
 * Re-export package. The runtime engine lives in the AIM agent-side SDK, at
 * `@opena2a/aim-sdk/arp`. Install this package to use ARP as a standalone
 * dependency without importing the SDK directly.
 *
 * The whole ARP surface is re-exported. Adding a symbol to the engine makes it
 * available here with no change to this file — an earlier frozen name list
 * silently hid 45 of 86 symbols, including both consent functions.
 *
 * Two values are this package's own: `AgentRuntimeProtection` extends the
 * engine's class with AI-layer capture (./runtime), and
 * `DEFAULT_MODEL_API_HOSTS` lists the model API hosts capture scans when the
 * config names none. The `ARPConfig` and `AILayerConfig` types carry the
 * capture settings.
 *
 * @example
 *   import { AgentRuntimeProtection, scanText, ALL_PATTERNS } from 'agent-runtime-protection';
 *
 *   const arp = new AgentRuntimeProtection({ agentName: 'my-agent' });
 *   await arp.start();
 */
export * from '@opena2a/aim-sdk/arp';
export { AgentRuntimeProtection } from './runtime';
export type { AILayerConfig, ARPConfig } from './runtime';
export { DEFAULT_MODEL_API_HOSTS } from './ai-capture';
