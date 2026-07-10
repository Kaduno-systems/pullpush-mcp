import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Env } from './env.js';

const PKG_NAME = 'kaduno-pullpush-mcp';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * Stdio MCP proxy — forwards all requests to the remote PullPush API.
 * Flow: IDE → stdio → [this proxy] → HTTPS → PullPush API /mcp
 */
export async function startProxy(env: Env, version: string): Promise<void> {
  const remoteUrl = new URL('/mcp', env.PULLPUSH_API_URL);

  const remoteTransport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${env.PULLPUSH_API_KEY}`,
        'X-MCP-Client': `${PKG_NAME}/${version}`,
        'X-MCP-Scope': 'operator',
      },
    },
  });

  const remoteClient = new Client(
    { name: `${PKG_NAME}-proxy`, version },
    { capabilities: {} },
  );

  try {
    await remoteClient.connect(remoteTransport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${PKG_NAME}] Failed to connect to PullPush API at ${remoteUrl.href}\n` +
        `  Error: ${msg}\n\n` +
        `  Check that:\n` +
        `  - The API is running and reachable\n` +
        `  - Your PULLPUSH_API_KEY is valid\n` +
        `  - PULLPUSH_API_URL is correct (current: ${env.PULLPUSH_API_URL})\n\n` +
        `  Common fixes:\n` +
        `  - Get a key from your PullPush admin panel → Settings → API Keys\n` +
        `  - For self-hosted: set PULLPUSH_API_URL=https://your-instance.com\n`,
    );
    process.exit(1);
  }

  let toolsCache = await remoteClient.listTools().catch(() => ({ tools: [] }));
  let resourcesCache = await remoteClient.listResources().catch(() => ({ resources: [] }));
  let promptsCache = await remoteClient.listPrompts().catch(() => ({ prompts: [] }));

  const refreshCatalog = async () => {
    try {
      const [t, r, p] = await Promise.all([
        remoteClient.listTools().catch(() => null),
        remoteClient.listResources().catch(() => null),
        remoteClient.listPrompts().catch(() => null),
      ]);
      if (t) toolsCache = t;
      if (r) resourcesCache = r;
      if (p) promptsCache = p;
    } catch {
      // Continue with stale cache
    }
  };

  const refreshTimer = setInterval(refreshCatalog, REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  const server = new Server(
    { name: PKG_NAME, version },
    {
      capabilities: {
        tools: toolsCache.tools.length > 0 ? {} : undefined,
        resources: {},
        prompts: promptsCache.prompts.length > 0 ? {} : undefined,
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsCache.tools,
  }));

  const PROXY_TIMEOUT_MS = Number(process.env.PULLPUSH_TIMEOUT_MS) || 55_000;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const callWithTimeout = async (): Promise<Awaited<ReturnType<typeof remoteClient.callTool>>> => {
      const TIMEOUT_SENTINEL = Symbol('proxy-timeout');
      const timer = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        const t = setTimeout(() => resolve(TIMEOUT_SENTINEL), PROXY_TIMEOUT_MS);
        if (typeof t === 'object' && 'unref' in t) t.unref();
      });

      const raceResult = await Promise.race([
        remoteClient.callTool({ name, arguments: args }),
        timer,
      ]);

      if (raceResult === TIMEOUT_SENTINEL) {
        return {
          content: [{
            type: 'text' as const,
            text: [
              `**Error: Tool \`${name}\` did not respond within ${PROXY_TIMEOUT_MS / 1000}s**`,
              '',
              '**What to do:** The operation may still be running on the server.',
              '- Use `pullpush.ops action=operation.list` to check for background operations',
              '- Retry with `background=true` in params to get an operationId immediately',
              '- Use narrower parameters (single key, limit, diffFilter) for faster results',
              '',
              '_This error may be transient — retrying could work._',
            ].join('\n'),
          }],
          isError: true,
          structuredContent: {
            code: 'PROXY_TIMEOUT',
            message: `Tool ${name} did not respond within ${PROXY_TIMEOUT_MS / 1000}s`,
            suggestion: 'The operation may still be running server-side. Try with background=true or narrower params.',
            suggestedTool: 'pullpush.ops action=operation.list',
            retryable: true,
          },
        } as Awaited<ReturnType<typeof remoteClient.callTool>>;
      }

      return raceResult;
    };

    try {
      return await callWithTimeout();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('unknown tool')) {
        await refreshCatalog();
        return await callWithTimeout();
      }
      throw err;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [...resourcesCache.resources];
    const hasLocalQuickstart = resources.some((r) => r.uri === 'pullpush://docs/quickstart-local');
    if (!hasLocalQuickstart) {
      resources.push({
        uri: 'pullpush://docs/quickstart-local',
        name: 'Quickstart (local)',
        description: 'Getting started with PullPush MCP — available offline',
        mimeType: 'text/markdown',
      });
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'pullpush://docs/quickstart-local') {
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: QUICKSTART }],
      };
    }
    return await remoteClient.readResource({ uri });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: promptsCache.prompts,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await remoteClient.getPrompt({
      name: request.params.name,
      arguments: request.params.arguments,
    });
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  process.stderr.write(
    `[${PKG_NAME}] v${version} connected to ${env.PULLPUSH_API_URL} — ` +
      `${toolsCache.tools.length} tools, ` +
      `${resourcesCache.resources.length} resources, ` +
      `${promptsCache.prompts.length} prompts` +
      ` (auto-refresh every 5m)\n`,
  );
}
