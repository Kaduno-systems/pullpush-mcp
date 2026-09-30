import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface RemoteLinkOptions {
  url: URL;
  apiKey: string;
  /** npm package name; sent as `X-MCP-Client` and used as the client name. */
  pkgName: string;
  /** Product name for log lines, e.g. "PullPush". */
  label: string;
  /** Sent as `X-MCP-Scope`. */
  scope: string;
  /** Appended to the log line when the remote refuses the key (401/403). */
  authHint: string;
  version: string;
  /** First retry delay; doubles per failed attempt up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Ceiling for a server-supplied Retry-After, so one bad header cannot park the proxy for hours. */
  retryAfterMaxMs: number;
  random?: () => number;
  log: (line: string) => void;
}

export type LinkState = 'connecting' | 'connected' | 'disconnected';

/** How a failed remote call should be handled by the caller. */
export type FailureKind =
  /** The remote answered with a protocol-level error (bad params, unknown tool): pass it through. */
  | 'remote-error'
  /** Session gone or rejected (404/401, closed transport): reconnect, then retry. */
  | 'session-lost'
  /** Reachable but refusing or failing right now (429, 5xx, network): retry later. */
  | 'unavailable';

/**
 * The connection to the remote PullPush MCP endpoint. It is never allowed to give up: whatever
 * happens, `start()` keeps trying in the background with exponential backoff and jitter until a
 * session is up, and a lost session is re-established the same way.
 */
export class RemoteLink {
  private client: Client | null = null;
  private currentState: LinkState = 'connecting';
  private loop: Promise<void> | null = null;
  private closed = false;
  private attempt = 0;
  private retryAfterMs = 0;
  private wake: (() => void) | null = null;
  private readyWaiters: Array<() => void> = [];
  private lastError = '';

  onConnected: (client: Client) => void = () => {};
  onCatalogueHint: () => void = () => {};

  constructor(private readonly opts: RemoteLinkOptions) {}

  get state(): LinkState {
    return this.currentState;
  }

  get lastFailure(): string {
    return this.lastError;
  }

  get remoteClient(): Client | null {
    return this.currentState === 'connected' ? this.client : null;
  }

  /** Headers every request to the remote carries. */
  get requestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'X-MCP-Client': `${this.opts.pkgName}/${this.opts.version}`,
      'X-MCP-Scope': this.opts.scope,
    };
  }

  get url(): URL {
    return this.opts.url;
  }

  /** Begin connecting in the background. Never rejects. */
  start(): void {
    if (this.loop || this.closed) return;
    this.loop = this.connectLoop().finally(() => {
      this.loop = null;
    });
  }

  /** Resolves true once connected, or false after `ms` (or when the link is closed). */
  waitConnected(ms: number): Promise<boolean> {
    if (this.currentState === 'connected') return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      timer.unref();
      const done = () => {
        clearTimeout(timer);
        resolve(this.currentState === 'connected');
      };
      this.readyWaiters.push(done);
    });
  }

  /** Called when a call proves the session is gone: drop it and reconnect right away. */
  markLost(reason: string, failed?: Client): void {
    if (this.closed || this.currentState !== 'connected') return;
    // A call that failed on an already-replaced session must not tear down the new one.
    if (failed && failed !== this.client) return;
    this.lastError = reason;
    this.opts.log(`Lost the connection to ${this.opts.label} (${reason}) — reconnecting`);
    const old = this.client;
    this.client = null;
    this.currentState = 'disconnected';
    this.attempt = 0;
    void old?.close().catch(() => {});
    this.start();
  }

  classify(err: unknown): FailureKind {
    if (err instanceof StreamableHTTPError) {
      if (err.code === 404 || err.code === 401) return 'session-lost';
      return 'unavailable';
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/not connected|connection closed|session not found|transport/i.test(msg)) return 'session-lost';
    if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|terminated/i.test(msg)) {
      return 'unavailable';
    }
    return 'remote-error';
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    const old = this.client;
    this.client = null;
    this.currentState = 'disconnected';
    for (const w of this.readyWaiters.splice(0)) w();
    await old?.close().catch(() => {});
  }

  private delayFor(attempt: number): number {
    const random = this.opts.random ?? Math.random;
    const ceiling = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    // Equal jitter: half fixed, half random, so a fleet of proxies restarted together spreads out.
    const jittered = ceiling / 2 + random() * (ceiling / 2);
    return Math.max(jittered, Math.min(this.retryAfterMs, this.opts.retryAfterMaxMs));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async connectLoop(): Promise<void> {
    while (!this.closed) {
      this.currentState = this.currentState === 'connected' ? 'connected' : 'connecting';
      this.retryAfterMs = 0;
      try {
        this.client = await this.connectOnce();
        this.currentState = 'connected';
        this.attempt = 0;
        this.lastError = '';
        for (const w of this.readyWaiters.splice(0)) w();
        this.onConnected(this.client);
        return;
      } catch (err) {
        this.attempt += 1;
        this.currentState = 'disconnected';
        this.lastError = err instanceof Error ? err.message : String(err);
        const delay = this.delayFor(this.attempt);
        const refused = err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403);
        this.opts.log(
          `Cannot reach ${this.opts.label} at ${this.opts.url.href} (${this.lastError}) — ` +
            `attempt ${this.attempt}, retrying in ${Math.round(delay / 1000)}s` +
            (refused ? `. ${this.opts.authHint}` : ''),
        );
        await this.sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.opts.url, {
      requestInit: { headers: this.requestHeaders },
      // Reads Retry-After off 429/503 answers: the SDK's error carries only the status code.
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (res.status === 429 || res.status === 503) {
          this.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        }
        return res;
      },
    });
    const client = new Client({ name: `${this.opts.pkgName}-proxy`, version: this.opts.version }, { capabilities: {} });
    client.onclose = () => {
      this.markLost('transport closed', client);
    };
    client.onerror = () => {
      // Non-fatal stream errors; a real loss shows up as a failed call or a close.
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => this.onCatalogueHint());
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => this.onCatalogueHint());
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => this.onCatalogueHint());
    try {
      await client.connect(transport);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return client;
  }
}

/** Retry-After is delta-seconds or an HTTP date. Returns milliseconds, 0 when absent or unusable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/**
 * Fallback for when the SDK client rejects a tools/list answer (e.g. the server returns Zod shapes
 * instead of JSON Schema): ask over plain HTTP and take the tools as they come. Handles both a JSON
 * body and an SSE stream. Throws on network or HTTP failure; returns [] when there is nothing usable.
 */
export async function fetchToolsRaw(
  url: URL,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<Tool[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 99 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const json = dataLine ? dataLine.slice(6) : text.trimStart().startsWith('{') ? text : '';
  if (!json) return [];
  const parsed = JSON.parse(json) as { result?: { tools?: Tool[] } };
  return parsed.result?.tools ?? [];
}
