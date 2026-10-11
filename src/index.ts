/**
 * agent-runtime-protection — Agent Runtime Protection
 *
 * Thin re-export package. The runtime engine lives in the AIM agent-side SDK,
 * at `@opena2a/aim-sdk/arp`. Install this package to use ARP as a standalone
 * dependency without importing the SDK directly.
 *
 * The whole ARP surface is re-exported. Adding a symbol to the engine makes it
 * available here with no change to this file — an earlier frozen name list
 * silently hid 45 of 86 symbols, including both consent functions.
 *
 * @example
 *   import { AgentRuntimeProtection, scanText, ALL_PATTERNS } from 'agent-runtime-protection';
 *
 *   const arp = new AgentRuntimeProtection({ agentName: 'my-agent' });
 *   await arp.start();
 */
export * from '@opena2a/aim-sdk/arp';
