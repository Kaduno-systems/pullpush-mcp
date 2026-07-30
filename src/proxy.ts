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

interface RawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Fallback: fetch tools/list via raw HTTP when the SDK client validation rejects
 * the response (e.g. server returns Zod shapes instead of JSON Schema).
 */
async function fetchToolsRaw(apiUrl: string, apiKey: string, sessionId?: string): Promise<RawTool[]> {
  const url = new URL('/mcp', apiUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 99 }),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) return [];
  const parsed = JSON.parse(dataLine.slice(6));
  return parsed?.result?.tools ?? [];
}

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

  let toolsCache = await remoteClient.listTools().catch(async (err) => {
    process.stderr.write(`[${PKG_NAME}] SDK listTools validation failed, trying raw fallback...\n`);
    const rawTools = await fetchToolsRaw(env.PULLPUSH_API_URL, env.PULLPUSH_API_KEY).catch(() => []);
    if (rawTools.length > 0) {
      process.stderr.write(`[${PKG_NAME}] Raw fallback got ${rawTools.length} tools\n`);
      return { tools: rawTools as Awaited<ReturnType<typeof remoteClient.listTools>>['tools'] };
    }
    process.stderr.write(`[${PKG_NAME}] listTools failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { tools: [] as Awaited<ReturnType<typeof remoteClient.listTools>>['tools'] };
  });
  let resourcesCache = await remoteClient.listResources().catch((err) => {
    process.stderr.write(`[${PKG_NAME}] listResources failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { resources: [] as Awaited<ReturnType<typeof remoteClient.listResources>>['resources'] };
  });
  let promptsCache = await remoteClient.listPrompts().catch((err) => {
    process.stderr.write(`[${PKG_NAME}] listPrompts failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { prompts: [] as Awaited<ReturnType<typeof remoteClient.listPrompts>>['prompts'] };
  });

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
        tools: {},
        resources: {},
        prompts: {},
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
