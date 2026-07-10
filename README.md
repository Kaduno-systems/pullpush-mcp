# PullPush MCP — connect any two APIs and keep them in sync

[![npm](https://img.shields.io/npm/v/kaduno-pullpush-mcp)](https://www.npmjs.com/package/kaduno-pullpush-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20registry-ai.pullpush%2Fpullpush--mcp-a855f7)](https://registry.modelcontextprotocol.io/v0/servers?search=ai.pullpush/pullpush-mcp)
[![license](https://img.shields.io/badge/license-MIT-22c55e)](./LICENSE)

The official MCP server for [PullPush.ai](https://pullpush.ai) — an integration platform that
connects e-commerce stores, warehouses, marketplaces, ERPs, and POS systems, and keeps stock
levels, orders, and products in sync across all of them.

This server lets AI agents (Claude, Cursor, or anything that speaks
[Model Context Protocol](https://modelcontextprotocol.io)) build, run, and monitor those
integrations end to end: connect two systems, preview the sync safely, and cut over to live —
without a human clicking through a dashboard.

## Why agents like it

- **Deterministic runtime, no LLM in the hot path.** AI helps at build time (connector
  generation, field-mapping suggestions); the sync engine itself is predictable, versioned,
  and observable.
- **Safe by default.** New flows start in **shadow mode** (read-only). `pullpush.sync`
  `action:"preview"` shows a structured source-vs-destination diff before anything is written.
- **Credentials never touch your machine or env.** Connection secrets are envelope-encrypted
  (AES-256-GCM, per-tenant keys) server-side the moment they're created.
- **Self-describing.** A `get-started` MCP prompt walks from zero to a working integration;
  `pullpush://` resources expose the tool catalog, quickstart, and agent guide — no pre-briefing
  needed.
- **Structured, actionable errors.** Failures return `{code, suggestion, suggestedTool,
  retryable}` — an agent always knows the next step.
- **Server-grade reliability.** Circuit breakers, per-key ordered delivery, idempotency,
  dead-letter queue with retry, exponential backoff.

## Quick start

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

Add this to `~/.cursor/mcp.json` (Cursor), Claude Desktop's config, or the MCP config for your
client. Prefer a remote server? Connect straight to the hosted endpoint instead:

```json
{
  "mcpServers": {
    "pullpush": {
      "type": "streamable-http",
      "url": "https://api.pullpush.ai/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

Then ask your agent to run the **`get-started`** prompt — it walks through the whole flow:
catalog connectors → create + test connections → suggest a field mapping → create the flow in
shadow mode → preview the diff → cut over.

## Getting an API key

1. [Sign up free](https://app.pullpush.ai/sign-up) (1 connection, 1,000 events/month — no card)
2. Admin panel → **Settings → API Keys**
3. Create a key with the scope you need (tenant, org, or admin)

## What's inside

**45 tools** (**28 explicit tools** plus **173 actions** across 17 domain routers) covering the
full integration lifecycle:

- **Connections** — create, test, and configure links to external systems (23+ built-in
  platforms: Shopify, WooCommerce, Magento, Amazon, Linnworks, Xero, HubSpot, …); any REST,
  GraphQL, or MCP API via the AI connector builder
- **Flows** — wire source → destination sync pipelines in canonical data models
  (stock levels, products, orders)
- **Sync** — preview, reconcile, and monitor; structured diffs in canonical space
- **Shadow mode** — run new integrations read-only until proven, then cut over
- **Diagnostics** — `pullpush.explain` diagnoses failures with evidence and suggested fixes
- **Ops** — health dashboards, anomaly detection, dead-letter recovery
- **Workflows** — multi-step DAG automations with branches, delays, and lookups
- **Import/Export** — file-based data in and out

Full tool reference: [pullpush.ai/docs/mcp](https://pullpush.ai/docs/mcp)

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PULLPUSH_API_KEY` | Yes | — | Your PullPush API key |
| `PULLPUSH_API_URL` | No | `https://api.pullpush.ai` | API base URL (override for self-hosted) |

## Auth scopes

| Scope | Access |
| --- | --- |
| **Tenant key** | Your tenant's connections, flows, sync, diagnostics |
| **Org key** | All tenants in your organization (read or read+write) |
| **Admin key** | Full platform access (billing, partners, all tenants) |

Tools are automatically scoped: a tenant key never sees another tenant's data.

## Features

- **Auto-refresh**: tool catalog refreshes every 5 minutes — new server-side tools appear
  without a restart
- **Offline quickstart**: built-in `pullpush://docs/quickstart-local` resource works without
  network
- **Retry on unknown tool**: automatically refreshes the catalog when a tool is not found
- **Clear error messages**: auth failures, network issues, and version mismatches are explained

## Documentation

- [Getting started](https://pullpush.ai/docs/getting-started) — 5 minutes to a first integration
- [MCP guide](https://pullpush.ai/docs/mcp) — full tool reference and client setup
- [Shadow mode](https://pullpush.ai/docs/shadow-mode) · [Preview & reconcile](https://pullpush.ai/docs/preview-reconcile) · [Security](https://pullpush.ai/docs/security)
- [llms.txt](https://pullpush.ai/llms.txt) — machine-readable product summary
- [Machine-readable integration catalog](https://pullpush.ai/api/integrations)
- MCP registry entry: [`ai.pullpush/pullpush-mcp`](https://registry.modelcontextprotocol.io/v0/servers?search=ai.pullpush/pullpush-mcp)

## Also available: pullpush-mcp-dev

For connector authors, platform admins, and internal developers,
[pullpush-mcp-dev](https://www.npmjs.com/package/pullpush-mcp-dev) exposes additional tools for:

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

This repository is a published mirror of the MCP client package; the platform itself is
developed in a private monorepo. Issues and questions are welcome here or at
[hello@pullpush.ai](mailto:hello@pullpush.ai).

## License

MIT
