import type { Env } from './env.js';
import { startResilientProxy, type ProxyHandle, type ProxyOptions, type ProxyProfile } from './core.js';

export { RECONNECTING_MESSAGE, type ProxyHandle, type ProxyOptions } from './core.js';

const QUICKSTART = `# PullPush MCP — Quick Start

## What is this?
PullPush MCP connects your AI coding assistant (Cursor, Claude Desktop, etc.)
to your PullPush integration sync engine. You can manage connections, flows,
sync operations, and diagnostics through natural language.

## Available commands
- **Connections**: Create, test, and manage source/destination connectors
- **Flows**: Set up sync flows between connections
- **Sync**: Preview changes, reconcile data, inspect snapshots
- **Shadow mode**: Test sync safely before going live
- **Diagnostics**: Explain failures, trace events, get AI remediation
- **Ops**: Dead-letter management, anomaly detection, health monitoring

## Getting started
1. Try \`pullpush.health.overview\` to see your tenant health
2. Use \`pullpush.connection\` with action "list" to see your connections
3. Use \`pullpush.flow\` with action "list" to see your flows
4. Use \`pullpush.sync\` with action "preview" to preview sync changes

## Auth levels
Your API key scope determines which tools are available:
- **Tenant key**: Your tenant's connections, flows, sync, diagnostics
- **Org key**: All tenants in your organization
- **Admin key**: Full platform access including billing and partners

## Resources
Read \`pullpush://docs/agent-guide\` for the full integration guide.
Read \`pullpush://tools/catalog\` for the complete tool reference.
`;

export const PROFILE: ProxyProfile = {
  pkgName: 'kaduno-pullpush-mcp',
  label: 'PullPush',
  scope: 'operator',
  authHint:
    'Check PULLPUSH_API_KEY (PullPush admin panel → Settings → API Keys) and PULLPUSH_API_URL',
  localResource: {
    uri: 'pullpush://docs/quickstart-local',
    name: 'Quickstart (local)',
    description: 'Getting started with PullPush MCP — available offline',
    text: QUICKSTART,
  },
};

/**
 * Stdio MCP proxy — forwards all requests to the remote PullPush API. It never exits on a failed
 * connect or a lost connection; see `core.ts`.
 */
export function startProxy(env: Env, version: string, options: ProxyOptions = {}): Promise<ProxyHandle> {
  return startResilientProxy(PROFILE, env, version, options);
}
