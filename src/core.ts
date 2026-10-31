import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolResult,
  type Prompt,
  type Resource,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Env } from './env.js';
import {
  EMPTY_CATALOGUE,
  cacheFileFor,
  defaultCacheDir,
  fingerprint,
  loadCatalogue,
  saveCatalogue,
  type Catalogue,
} from './catalogue.js';
import { RemoteLink, fetchToolsRaw } from './remote.js';

/**
 * This file, `remote.ts` and `catalogue.ts` are byte-identical in `publish/mcp` and `publish/mcp-dev`
 * (the packages are published separately and cannot import each other); a test in mcp-dev fails when
 * they drift. Everything that differs between the two packages is in this profile.
 */
export interface ProxyProfile {
  /** npm package name. */
  pkgName: string;
  /** Product name for messages. */
  label: string;
  /** Sent as `X-MCP-Scope`. */
  scope: string;
  /** Shown in the log when the remote refuses the API key. */
  authHint: string;
  /** A resource served from the package itself, so it works offline. */
  localResource: { uri: string; name: string; description: string; text: string };
}

export const RECONNECTING_MESSAGE =
  'PullPush is reconnecting — retry in a few seconds. Nothing was changed by this call.';

export interface ProxyOptions {
  /** Client-facing transport; stdio unless a test supplies its own. */
  transport?: Transport;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  retryAfterMaxMs?: number;
  /** Without a cached catalogue, how long to hold the client's initialize for the first connect. */
  startupWaitMs?: number;
  /** How long tools/list waits for the very first catalogue when there is no cache. */
  listWaitMs?: number;
  /** How long a tool call waits for an in-progress (re)connect before answering "reconnecting". */
  callWaitMs?: number;
  refreshIntervalMs?: number;
  callTimeoutMs?: number;
  cacheDir?: string;
  log?: (line: string) => void;
}

export interface ProxyHandle {
  close(): Promise<void>;
}

function envMs(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function reconnectingResult(detail?: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: detail ? `${RECONNECTING_MESSAGE}\n(${detail})` : RECONNECTING_MESSAGE }],
    structuredContent: {
      code: 'PROXY_RECONNECTING',
      message: RECONNECTING_MESSAGE,
      retryable: true,
      ...(detail ? { detail } : {}),
    },
  };
}

async function listAllResources(client: Client): Promise<Resource[]> {
  const resources: Resource[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined);
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

async function listAllPrompts(client: Client): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listPrompts(cursor ? { cursor } : undefined);
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}

/**
 * Stdio MCP proxy — forwards all requests to the remote PullPush API.
 * Flow: IDE → stdio → [this proxy] → HTTPS → PullPush API /mcp
 *
 * The local stdio server always starts. The remote is connected in the background and reconnected
 * whenever it is lost, so a network blip, a 429 or an API restart never leaves a session without its
 * tools for the rest of its life: a stdio server that exits is never respawned by the client.
 */
export async function startResilientProxy(
  profile: ProxyProfile,
  env: Env,
  version: string,
  options: ProxyOptions = {},
): Promise<ProxyHandle> {
  const { pkgName, label } = profile;
  const log = options.log ?? ((line: string) => void process.stderr.write(`[${pkgName}] ${line}\n`));
  const remoteUrl = new URL('/mcp', env.PULLPUSH_API_URL);

  const callTimeoutMs = options.callTimeoutMs ?? envMs('PULLPUSH_TIMEOUT_MS') ?? 55_000;
  const startupWaitMs = options.startupWaitMs ?? envMs('PULLPUSH_STARTUP_WAIT_MS') ?? 8_000;
  const listWaitMs = options.listWaitMs ?? 12_000;
  const callWaitMs = options.callWaitMs ?? 5_000;
  // The PullPush endpoint is stateless and never pushes list_changed, so polling is how new
  // server-side tools reach a running session. The fingerprint keeps an unchanged poll silent.
  const refreshIntervalMs = options.refreshIntervalMs ?? envMs('PULLPUSH_REFRESH_MS') ?? 5 * 60 * 1000;

  // Catalogue cache: lets a restart answer tools/list and initialize instantly, even with the remote down.
  const cacheFile = cacheFileFor(
    options.cacheDir ?? defaultCacheDir(pkgName),
    env.PULLPUSH_API_URL,
    env.PULLPUSH_API_KEY,
    profile.scope,
  );
  const cached = loadCatalogue(cacheFile);
  let catalogue: Catalogue = cached ?? EMPTY_CATALOGUE;
  let toolsFp = fingerprint(catalogue.tools);
  let resourcesFp = fingerprint(catalogue.resources);
  let promptsFp = fingerprint(catalogue.prompts);
  let loadedFromRemote = false;
  let closed = false;
  /** Set once the client-facing server is connected; nothing is announced before that. */
  let attached: Server | null = null;
  let waitedForFirstList = false;

  const link = new RemoteLink({
    url: remoteUrl,
    apiKey: env.PULLPUSH_API_KEY,
    pkgName,
    label,
    scope: profile.scope,
    authHint: profile.authHint,
    version,
    backoffBaseMs: options.backoffBaseMs ?? 1_000,
    backoffMaxMs: options.backoffMaxMs ?? 60_000,
    retryAfterMaxMs: options.retryAfterMaxMs ?? 5 * 60_000,
    log,
  });

  let firstLoad!: () => void;
  const firstCatalogue = new Promise<void>((resolve) => (firstLoad = resolve));

  const notifyChanged = (tools: boolean, resources: boolean, prompts: boolean) => {
    if (!attached || closed) return;
    if (tools) void attached.sendToolListChanged().catch(() => {});
    if (resources) void attached.sendResourceListChanged().catch(() => {});
    if (prompts) void attached.sendPromptListChanged().catch(() => {});
  };

  /**
   * tools/list through the SDK client, which validates the answer. When that validation rejects it
   * (the server returns Zod shapes instead of JSON Schema) fall back to a raw HTTP request and take
   * the tools as they are.
   */
  const listTools = async (client: Client): Promise<Tool[]> => {
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    } catch (err) {
      log('SDK listTools validation failed, trying raw fallback...');
      const raw = await fetchToolsRaw(remoteUrl, link.requestHeaders).catch(() => []);
      if (raw.length > 0) {
        log(`Raw fallback got ${raw.length} tools`);
        return raw;
      }
      throw err;
    }
  };

  let retryTimer: NodeJS.Timeout | undefined;

  /** Re-read the remote catalogue; tell the client only if it actually differs from what it was served. */
  const refreshCatalogue = async (): Promise<void> => {
    const client = link.remoteClient;
    if (!client || closed) return;
    try {
      // The three lists fail independently (a remote may not offer prompts at all), and a failed
      // resources or prompts half keeps its previous value rather than blanking the client's list.
      // Tools are the point of the proxy: without them this refresh did not happen.
      const [toolsResult, resourcesResult, promptsResult] = await Promise.allSettled([
        listTools(client),
        listAllResources(client),
        listAllPrompts(client),
      ]);
      if (toolsResult.status === 'rejected') throw toolsResult.reason;
      const tools = toolsResult.value;
      const resources = resourcesResult.status === 'fulfilled' ? resourcesResult.value : catalogue.resources;
      const prompts = promptsResult.status === 'fulfilled' ? promptsResult.value : catalogue.prompts;
      const next: Catalogue = {
        tools,
        resources,
        prompts,
        instructions: client.getInstructions() ?? catalogue.instructions,
      };
      const newToolsFp = fingerprint(tools);
      const newResourcesFp = fingerprint(resources);
      const newPromptsFp = fingerprint(prompts);
      const toolsChanged = newToolsFp !== toolsFp;
      const resourcesChanged = newResourcesFp !== resourcesFp;
      const promptsChanged = newPromptsFp !== promptsFp;
      const instructionsChanged = next.instructions !== catalogue.instructions;
      catalogue = next;
      toolsFp = newToolsFp;
      resourcesFp = newResourcesFp;
      promptsFp = newPromptsFp;
      if (toolsChanged || resourcesChanged || promptsChanged || instructionsChanged || !loadedFromRemote) {
        saveCatalogue(cacheFile, catalogue);
      }
      loadedFromRemote = true;
      firstLoad();
      notifyChanged(toolsChanged, resourcesChanged, promptsChanged);
    } catch (err) {
      // Keep serving what we have. Connected but nothing loaded yet: try again shortly rather than
      // wait for the next interval with an empty tool list.
      log(`Could not refresh the tool catalogue: ${err instanceof Error ? err.message : String(err)}`);
      if (!loadedFromRemote && !closed) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void refreshCatalogue(), 5_000);
        retryTimer.unref();
      }
    }
  };

  let hintTimer: NodeJS.Timeout | undefined;
  link.onConnected = () => void refreshCatalogue();
  link.onCatalogueHint = () => {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => void refreshCatalogue(), 1_000);
    hintTimer.unref();
  };

  link.start();

  // The instructions are part of the initialize response and fixed for the life of the session, so
  // without a cache hold initialize briefly for the first connect rather than start without them.
  if (!cached) {
    let startupTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      firstCatalogue,
      // Deliberately ref'd: until stdio is attached nothing else keeps the process alive, and an
      // unref'd timer here let the process exit (code 13) in the middle of this wait.
      new Promise<void>((resolve) => {
        startupTimer = setTimeout(resolve, startupWaitMs);
      }),
    ]);
    clearTimeout(startupTimer);
  }

  const server = new Server(
    { name: pkgName, version },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions: catalogue.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A cached catalogue is served at once; a `list_changed` follows if the remote differs. Without
    // one, give the first connect a bounded chance before answering (empty, then list_changed).
    if (!loadedFromRemote && !cached && !waitedForFirstList) {
      // Only the first request waits; a client polling an unreachable remote is answered at once.
      waitedForFirstList = true;
      await Promise.race([
        firstCatalogue,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, listWaitMs);
          t.unref();
        }),
      ]);
    }
    return { tools: catalogue.tools };
  });

  /**
   * Run one remote call. A request the server rejected outright (404/401: session unknown) was not
   * processed, so it is safe to reconnect and send it once more; anything else that fails in flight is
   * reported as retryable and left to the caller, because a write may or may not have landed.
   */
  const withRemote = async <T>(
    call: (client: Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; detail: string }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let client = link.remoteClient;
      if (!client) {
        await link.waitConnected(callWaitMs);
        client = link.remoteClient;
      }
      if (!client) return { ok: false, detail: link.lastFailure };
      try {
        return { ok: true, value: await call(client) };
      } catch (err) {
        const kind = link.classify(err);
        if (kind === 'remote-error') throw err;
        const detail = err instanceof Error ? err.message : String(err);
        if (kind === 'session-lost') link.markLost(detail, client);
        const rejectedUnprocessed = err instanceof StreamableHTTPError && (err.code === 404 || err.code === 401);
        if (!(kind === 'session-lost' && rejectedUnprocessed && attempt === 0)) return { ok: false, detail };
      }
    }
    return { ok: false, detail: link.lastFailure };
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const TIMEOUT_SENTINEL = Symbol('proxy-timeout');

    const attemptCall = async () =>
      withRemote(async (client) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), callTimeoutMs);
          timer.unref();
        });
        try {
          return await Promise.race([client.callTool({ name, arguments: args }), timeout]);
        } finally {
          clearTimeout(timer);
        }
      });

    const timeoutResult = (): CallToolResult => ({
      content: [
        {
          type: 'text' as const,
          text: [
            `**Error: Tool \`${name}\` did not respond within ${callTimeoutMs / 1000}s**`,
            '',
            '**What to do:** The operation may still be running on the server.',
            '- Use `pullpush.ops action=operations.list` to check for background operations',
            '- Retry with `background=true` in params to get an operationId immediately',
            '- Use narrower parameters (single key, limit, diffFilter) for faster results',
            '',
            '_This error may be transient — retrying could work._',
          ].join('\n'),
        },
      ],
      isError: true,
      structuredContent: {
        code: 'PROXY_TIMEOUT',
        message: `Tool ${name} did not respond within ${callTimeoutMs / 1000}s`,
        suggestion: 'The operation may still be running server-side. Try with background=true or narrower params.',
        suggestedTool: 'pullpush.ops action=operations.list',
        retryable: true,
      },
    });

    const run = async (): Promise<CallToolResult> => {
      const outcome = await attemptCall();
      if (!outcome.ok) return reconnectingResult(outcome.detail || undefined);
      if (outcome.value === TIMEOUT_SENTINEL) return timeoutResult();
      return outcome.value as CallToolResult;
    };

    const looksUnknown = (text: string) => /unknown tool|tool .*not found|not found/i.test(text);

    let result: CallToolResult;
    try {
      result = await run();
    } catch (err) {
      // The remote no longer knows the tool: our catalogue is stale. Refresh it once and retry.
      if (!looksUnknown(err instanceof Error ? err.message : String(err))) throw err;
      await refreshCatalogue();
      return await run();
    }
    const first = result.content?.[0];
    if (result.isError && first?.type === 'text' && /^(unknown tool|tool \S+ not found)/i.test(first.text)) {
      await refreshCatalogue();
      return await run();
    }
    return result;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [...catalogue.resources];
    if (!resources.some((r) => r.uri === profile.localResource.uri)) {
      resources.push({
        uri: profile.localResource.uri,
        name: profile.localResource.name,
        description: profile.localResource.description,
        mimeType: 'text/markdown',
      });
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === profile.localResource.uri) {
      return { contents: [{ uri, mimeType: 'text/markdown', text: profile.localResource.text }] };
    }
    const outcome = await withRemote((client) => client.readResource({ uri }));
    if (!outcome.ok) throw new Error(RECONNECTING_MESSAGE);
    return outcome.value;
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: catalogue.prompts }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const outcome = await withRemote((client) =>
      client.getPrompt({ name: request.params.name, arguments: request.params.arguments }),
    );
    if (!outcome.ok) throw new Error(RECONNECTING_MESSAGE);
    return outcome.value;
  });

  await server.connect(options.transport ?? new StdioServerTransport());
  attached = server;

  const refreshTimer = setInterval(() => void refreshCatalogue(), refreshIntervalMs);
  refreshTimer.unref();

  log(
    `v${version} started for ${env.PULLPUSH_API_URL} — remote ${link.state}, ` +
      `${catalogue.tools.length} tools${cached && !loadedFromRemote ? ' (cached)' : ''}, ` +
      `auto-refresh every ${Math.round(refreshIntervalMs / 60_000)}m`,
  );

  const shutdown = async () => {
    if (closed) return;
    closed = true;
    clearInterval(refreshTimer);
    clearTimeout(hintTimer);
    clearTimeout(retryTimer);
    await link.close();
  };
  server.onclose = () => void shutdown();

  return {
    close: async () => {
      await shutdown();
      await server.close().catch(() => {});
    },
  };
}
