# kaduno-pullpush-mcp

MCP server for [PullPush.ai](https://pullpush.ai) — connect Cursor, Claude Desktop, and AI agents to your integration sync engine.

Ships **43 tools** (137 integration actions across 16 domain routers) for managing connectors, flows, sync operations, diagnostics, and more — all through the Model Context Protocol.

## Quick Start

No clone or install needed — run directly via `npx`:

```json
{
  "mcpServers": {
    "pullpush": {
      "command": "npx",
      "args": ["-y", "kaduno-pullpush-mcp@latest"],
      "env": {
        "PULLPUSH_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Add this to `~/.cursor/mcp.json` (Cursor) or the MCP config for your client. That's it — `npx` downloads and runs the server automatically.

## Getting Your API Key

1. Log in to your PullPush admin panel
2. Navigate to Settings → API Keys
3. Create a new key with the appropriate scope (tenant, org, or admin)

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PULLPUSH_API_KEY` | Yes | — | Your PullPush API key |
| `PULLPUSH_API_URL` | No | `https://api.pullpush.ai` | API base URL (override for self-hosted) |

## CLI Flags

| Flag | Description |
| --- | --- |
| `--help` | Show usage help |
| `--version` | Show version |

## Auth Levels

The tools available depend on your API key scope:

| Scope | Access |
| --- | --- |
| **Tenant key** | Your tenant's connections, flows, sync, diagnostics |
| **Org key** | All tenants in your organization (read or read+write) |
| **Admin key** | Full platform access (billing, partners, all tenants) |

## Tools

The MCP server exposes 43 tools (137 actions across 16 domain routers) covering:

- **Connections** — create, test, configure source and destination connectors
- **Flows** — create and manage sync flows between connections
- **Sync** — preview, reconcile, and monitor data synchronization
- **Shadow mode** — test sync safely before going live
- **Diagnostics** — explain failures, trace events, AI remediation
- **Ops** — anomaly detection, dead-letter management, health monitoring
- **Workflows** — multi-step automation pipelines
- **Integrations** — group flows and workflows into logical units
- **Import/Export** — file-based data import and export

## Features

- **Auto-refresh**: Tool catalog refreshes every 5 minutes (no restart needed for new tools)
- **Offline quickstart**: Built-in `pullpush://docs/quickstart-local` resource works without network
- **Retry on unknown tool**: Automatically refreshes catalog when a tool is not found
- **Clear error messages**: Auth failures, network issues, and version mismatches are explained

## Self-Hosted / Staging

Override the API URL for self-hosted deployments:

```json
{
  "mcpServers": {
    "pullpush": {
      "command": "npx",
      "args": ["-y", "kaduno-pullpush-mcp@latest"],
      "env": {
        "PULLPUSH_API_KEY": "<your-api-key>",
        "PULLPUSH_API_URL": "https://your-pullpush-instance.com"
      }
    }
  }
}
```

## Also Available: pullpush-mcp-dev

For connector authors, platform admins, and internal developers, see [pullpush-mcp-dev](https://www.npmjs.com/package/pullpush-mcp-dev) which exposes additional tools for:

- AI-powered connector generation and composition
- Canonical schema management
- Marketplace publishing
- Billing and partner administration
- Batch operations across all tenants

## Development

```bash
git clone https://github.com/Kaduno-systems/pullpush-mcp.git
cd pullpush-mcp
npm install
npm run dev    # Run from source via tsx
npm run build  # Compile with tsup
```

## License

MIT
