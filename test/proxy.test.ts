import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startProxy, RECONNECTING_MESSAGE, type ProxyHandle } from '../src/proxy.js';
import { FakeRemote } from './fake-remote.js';

// The one thing that differs between kaduno-pullpush-mcp and pullpush-mcp-dev.
const PKG = 'kaduno-pullpush-mcp';
const SCOPE = 'operator';
const LOCAL_RESOURCE = 'pullpush://docs/quickstart-local';

const API_KEY = 'pp_live_secret_test_key';

const FAST = {
  backoffBaseMs: 40,
  backoffMaxMs: 200,
  startupWaitMs: 300,
  listWaitMs: 300,
  callWaitMs: 150,
  log: (l: string) => void (process.env.PP_DEBUG && console.error(l)),
};

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

describe(`${PKG} proxy resilience`, () => {
  let remote: FakeRemote;
  let cacheDir: string;
  const handles: ProxyHandle[] = [];
  const clients: Client[] = [];

  beforeEach(async () => {
    remote = new FakeRemote();
    await remote.start();
    cacheDir = mkdtempSync(join(tmpdir(), 'pp-mcp-test-'));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const h of handles.splice(0)) await h.close();
    await remote.stop().catch(() => {});
    rmSync(cacheDir, { recursive: true, force: true });
  });

  async function boot(overrides: Record<string, unknown> = {}, url = remote.url) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await startProxy({ PULLPUSH_API_KEY: API_KEY, PULLPUSH_API_URL: url }, '9.9.9', {
      ...FAST,
      cacheDir,
      transport: serverSide,
      ...overrides,
    });
    handles.push(handle);
    const client = new Client({ name: 'test-client', version: '1' }, { capabilities: {} });
    clients.push(client);
    await client.connect(clientSide);
    return client;
  }

  const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
  const BOTH = ['pullpush.flow', 'pullpush.health.overview'];

  it('stays alive when the remote is down at startup and recovers once it is up', async () => {
    remote.mode = { kind: 'down' };
    const client = await boot();
    // Started, answering, no tools yet.
    expect(await toolNames(client)).toEqual([]);

    const changed = new Promise<void>((resolve) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve()),
    );
    remote.mode = { kind: 'ok' };
    await changed;
    expect(await toolNames(client)).toEqual(BOTH);

    const res = await client.callTool({ name: 'pullpush.flow', arguments: { q: 'x' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain('pullpush.flow');
  });

  it('forwards instructions, prompts and the local resource', async () => {
    const client = await boot();
    expect(client.getInstructions()).toBe('fake instructions');
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['get-started']);
    const prompt = await client.getPrompt({ name: 'get-started' });
    expect(JSON.stringify(prompt.messages)).toContain('start here');
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain(LOCAL_RESOURCE);
    const local = await client.readResource({ uri: LOCAL_RESOURCE });
    expect(JSON.stringify(local.contents)).toContain('PullPush MCP');
  });

  it('sends the API key, client and scope headers to the remote', async () => {
    const client = await boot();
    await toolNames(client);
    const init = remote.requests.find((r) => r.rpc.includes('initialize'))!;
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers['x-mcp-scope']).toBe(SCOPE);
    expect(init.headers['x-mcp-client']).toBe(`${PKG}/9.9.9`);
  });

  it('honours Retry-After on a 429', async () => {
    remote.mode = { kind: 'status', status: 429, retryAfter: '1' };
    await boot({ backoffBaseMs: 10, backoffMaxMs: 20 });
    await until(() => remote.requests.length >= 1);
    const first = remote.requests[0]!.at;
    await until(() => remote.requests.length >= 2, 4000);
    // Backoff alone would retry within ~20 ms; Retry-After: 1 forces at least a second.
    expect(remote.requests[1]!.at - first).toBeGreaterThanOrEqual(950);
  });

  it('reconnects after the remote session is lost', async () => {
    const client = await boot();
    await until(async () => (await toolNames(client)).length === 2);
    const initializesBefore = remote.rpcCount('initialize');

    remote.dropSessions(); // every existing session now answers 404
    const res = await client.callTool({ name: 'pullpush.flow', arguments: {} });
    expect(res.isError).toBeFalsy(); // the 404 was retried on a fresh session
    expect(remote.rpcCount('initialize')).toBe(initializesBefore + 1);
  });

  it('reconnects after the remote restarts', async () => {
    const client = await boot();
    await until(async () => (await toolNames(client)).length === 2);
    const initializesBefore = remote.rpcCount('initialize');
    remote.mode = { kind: 'down' };
    const failed = await client.callTool({ name: 'pullpush.flow', arguments: {} });
    expect(failed.isError).toBe(true);
    remote.dropSessions();
    remote.mode = { kind: 'ok' };
    await until(async () => {
      const r = await client.callTool({ name: 'pullpush.flow', arguments: {} });
      return !r.isError;
    });
    expect(remote.rpcCount('initialize')).toBeGreaterThan(initializesBefore);
  });

  it('answers a tool call with a retryable error while disconnected', async () => {
    remote.mode = { kind: 'down' };
    const client = await boot();
    const started = Date.now();
    const res = await client.callTool({ name: 'pullpush.flow', arguments: {} });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain(RECONNECTING_MESSAGE);
    expect(JSON.stringify(res.content)).toContain('retry in a few seconds');
    expect(JSON.stringify(res.content)).toContain('Nothing was changed by this call.');
    expect(res.structuredContent).toMatchObject({ code: 'PROXY_RECONNECTING', retryable: true });
  });

  it('serves the cached catalogue immediately on restart while the remote is down', async () => {
    const first = await boot();
    await until(async () => (await toolNames(first)).length === 2);
    await first.close();
    await handles.pop()!.close();

    remote.mode = { kind: 'down' };
    const client = await boot();
    expect(await toolNames(client)).toEqual(BOTH);
    expect(client.getInstructions()).toBe('fake instructions');
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['get-started']);
  });

  it('caches per key without ever writing the key to disk', async () => {
    const client = await boot();
    await until(async () => (await toolNames(client)).length === 2);
    await until(() => readdirSync(cacheDir).some((f) => f.startsWith('catalogue-')));
    for (const file of readdirSync(cacheDir)) {
      expect(file).not.toContain(API_KEY);
      expect(readFileSync(join(cacheDir, file), 'utf-8')).not.toContain(API_KEY);
    }
  });

  it('emits list_changed only when the catalogue really changed', async () => {
    const client = await boot();
    await until(async () => (await toolNames(client)).length === 2);
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void notifications++);

    // Force a reconnect with an identical catalogue: no notification.
    remote.dropSessions();
    await client.callTool({ name: 'pullpush.flow', arguments: {} });
    await new Promise((r) => setTimeout(r, 400));
    expect(notifications).toBe(0);

    // Now a genuinely new tool.
    remote.toolNames = ['pullpush.flow', 'pullpush.health.overview', 'pullpush.sync'];
    remote.dropSessions();
    await client.callTool({ name: 'pullpush.flow', arguments: {} });
    await until(() => notifications > 0);
    expect(await toolNames(client)).toEqual(['pullpush.flow', 'pullpush.health.overview', 'pullpush.sync']);
  });

  it('picks up new remote tools on the periodic refresh, and only announces a real change', async () => {
    remote.liveToolList = true;
    const client = await boot({ refreshIntervalMs: 150 });
    await until(async () => (await toolNames(client)).length === 2);
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void notifications++);

    await new Promise((r) => setTimeout(r, 500)); // several unchanged refreshes
    expect(notifications).toBe(0);

    remote.toolNames = ['pullpush.flow', 'pullpush.health.overview', 'pullpush.sync'];
    await until(() => notifications > 0);
    expect(await toolNames(client)).toContain('pullpush.sync');
  });

  it('falls back to a raw tools/list when the SDK rejects the schema', async () => {
    remote.mode = { kind: 'bad-tool-schemas' };
    const client = await boot();
    // The test client would reject these tools too, so read the list without schema validation.
    const rawToolNames = async () =>
      (
        await client.request(
          { method: 'tools/list' },
          z.object({ tools: z.array(z.object({ name: z.string() }).loose()) }).loose(),
        )
      ).tools.map((t) => t.name);
    await until(async () => (await rawToolNames()).includes('legacy.tool'));
    expect(await rawToolNames()).toEqual(['legacy.tool']);
    // The SDK request and the raw retry both went out.
    expect(remote.rpcCount('tools/list')).toBeGreaterThanOrEqual(2);
    const raw = remote.requests.filter((r) => r.rpc.includes('tools/list')).at(-1)!;
    expect(raw.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(raw.headers['x-mcp-scope']).toBe(SCOPE);
  });
});
