#!/usr/bin/env node

// A stray error from a background timer or the HTTP transport must not end the session: the proxy
// heals itself (it reconnects), while a dead stdio server is never respawned by the client.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[kaduno-pullpush-mcp] Unexpected error (continuing): ${err.message}\n${err.stack ?? ''}\n`);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[kaduno-pullpush-mcp] Unhandled rejection: ${msg}\n`);
});

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { startProxy } from './proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '2.0.0';
  } catch {
    return '2.0.0';
  }
}

const version = getVersion();

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`kaduno-pullpush-mcp v${version}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `kaduno-pullpush-mcp v${version}\n\n` +
      `MCP server for PullPush.ai — connect Cursor, Claude, and AI agents\n` +
      `to your integration sync engine.\n\n` +
      `Usage:\n` +
      `  npx kaduno-pullpush-mcp         Start the MCP server (stdio)\n` +
      `  npx kaduno-pullpush-mcp --help   Show this help\n` +
      `  npx kaduno-pullpush-mcp --version  Show version\n\n` +
      `Environment:\n` +
      `  PULLPUSH_API_KEY   (required) Your PullPush API key\n` +
      `  PULLPUSH_API_URL   (optional) API URL (default: https://api.pullpush.ai)\n` +
      `  PULLPUSH_CACHE_DIR (optional) Where the tool catalogue is cached (default: OS cache dir)\n\n` +
      `Install once: npm i -g kaduno-pullpush-mcp@${version}\n` +
      `Config (Cursor ~/.cursor/mcp.json):\n` +
      `  {\n` +
      `    "mcpServers": {\n` +
      `      "pullpush": {\n` +
      `        "command": "kaduno-pullpush-mcp",\n` +
      `        "env": { "PULLPUSH_API_KEY": "<your-key>" }\n` +
      `      }\n` +
      `    }\n` +
      `  }\n\n` +
      `Docs: https://pullpush.ai/docs/mcp\n`,
  );
  process.exit(0);
}

const env = loadEnv();
await startProxy(env, version);
