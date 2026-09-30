import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export type Mode =
  | { kind: 'ok' }
  /** tools/list answers with Zod-style shapes (no `type: "object"`) that the SDK client rejects. */
  | { kind: 'bad-tool-schemas' }
  | { kind: 'down' } // connection reset, as when the API is restarting
  | { kind: 'status'; status: number; retryAfter?: string };

/** A local stand-in for api.pullpush.ai/mcp. Stateful, so a session can be lost. */
export class FakeRemote {
  mode: Mode = { kind: 'ok' };
  requests: Array<{ method: string; rpc: string[]; at: number; headers: Record<string, string | string[] | undefined> }> = [];
  toolNames = ['pullpush.health.overview', 'pullpush.flow'];
  instructions = 'fake instructions';
  /** Answer tools/list from the current `toolNames` on existing sessions too (a server that gained a tool). */
  liveToolList = false;
  private sessions = new Map<string, StreamableHTTPServerTransport>();
  private http!: HttpServer;
  url = '';

  async start(port = 0): Promise<void> {
    this.http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.http.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Forget every session, as a restarted server would. */
  dropSessions(): void {
    this.sessions.clear();
  }

  rpcCount(method: string): number {
    return this.requests.filter((r) => r.rpc.includes(method)).length;
  }

  private buildServer(): McpServer {
    const server = new McpServer({ name: 'fake', version: '1.0.0' }, { instructions: this.instructions });
    server.prompt('get-started', 'Walk through a first integration', async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'start here' } }],
    }));
    for (const name of this.toolNames) {
      server.tool(name, `Fake ${name}`, { q: z.string().optional() }, async (args) => ({
        content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
      }));
    }
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    this.requests.push({
      method: req.method ?? '',
      rpc: msgs.map((m: { method?: string }) => m.method ?? ''),
      at: Date.now(),
      headers: req.headers,
    });

    if (this.mode.kind === 'down') {
      req.socket.destroy();
      return;
    }
    if (this.mode.kind === 'status') {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.mode.retryAfter) headers['retry-after'] = this.mode.retryAfter;
      res.writeHead(this.mode.status, headers).end(JSON.stringify({ error: 'nope' }));
      return;
    }

    if (this.mode.kind === 'bad-tool-schemas' && msgs.some((m: { method?: string }) => m.method === 'tools/list')) {
      const id = (msgs.find((m: { method?: string }) => m.method === 'tools/list') as { id: number }).id;
      const result = { tools: [{ name: 'legacy.tool', description: 'Zod shape', inputSchema: { shape: {} } }] };
      res
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
      return;
    }

    const listMsg = msgs.find((m: { method?: string }) => m.method === 'tools/list') as { id: number } | undefined;
    if (this.liveToolList && listMsg && typeof req.headers['mcp-session-id'] === 'string') {
      const tools = this.toolNames.map((name) => ({ name, description: `Fake ${name}`, inputSchema: { type: 'object' } }));
      res
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: listMsg.id, result: { tools } })}\n\n`);
      return;
    }

    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const transport = this.sessions.get(sid);
      if (!transport) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && msgs.some((m: { method?: string }) => m.method === 'initialize')) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void this.sessions.set(id, transport),
      });
      await this.buildServer().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400).end();
  }
}
