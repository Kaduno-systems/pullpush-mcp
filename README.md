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

## Try it in 60 seconds — no signup

```bash
curl -X POST https://api.pullpush.ai/api/sandbox
```

Returns a free 48-hour sandbox tenant: an API key, ready-to-paste MCP configs, and two
pre-wired demo connections whose stock data deliberately disagrees — so your first
`pullpush.sync` `action:"preview"` shows a real canonical diff (drifted quantities, a missing
item, in-sync rows). The sandbox deletes itself on expiry — or keep it:
`POST /api/sandbox/claim` (Bearer = the sandbox key, `{"email": "..."}`) converts it to a
persistent free tenant with everything you built preserved.

## Quick start

Connect straight to the hosted endpoint. It is the most robust option — nothing runs on your
machine, so there is no process to crash or go stale:

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

Add this to `~/.cursor/mcp.json` (Cursor), Claude Desktop's config, or the MCP config for your
client.

### Clients that only speak stdio

Use this package as a local stdio proxy to the same endpoint. Install a pinned version once and
run the binary — do not use `npx ...@latest`, which re-resolves the package (and needs the
network) every time your client starts the server:

```bash
npm i -g kaduno-pullpush-mcp@2.4.0
```

```json
{
  "mcpServers": {
    "pullpush": {
      "command": "kaduno-pullpush-mcp",
      "env": { "PULLPUSH_API_KEY": "<your-api-key>" }
    }
  }
}
```

The proxy never exits because the API is unreachable: it starts, answers your client, and
connects in the background (exponential backoff, honouring `Retry-After`). It reconnects after a
network blip or an API restart, and while it is offline a tool call returns a retryable
"reconnecting" error that changes nothing. The tool catalogue is cached on disk, so a restart
while the API is down still lists your tools.

Then ask your agent to run the **`get-started`** prompt — it walks through the whole flow:
catalog connectors → create + test connections → suggest a field mapping → create the flow in
shadow mode → preview the diff → cut over.

## Getting an API key

For a throwaway key, use the sandbox above. For a persistent tenant:

1. [Sign up free](https://app.pullpush.ai/sign-up) (1 connection, 1,000 events/month — no card)
2. Admin panel → **Settings → API Keys**
3. Create a key with the scope you need (tenant, org, or admin)

## Tools

**50 tools** (**30 explicit tools** plus **228 actions** across 20 domain routers) covering the
full integration lifecycle. Explicit tools are individually named; domain routers accept an
`action` parameter with multiple operations.

### Connections

- `pullpush.connection.create` — Create and configure a connection to an external system (Shopify, WooCommerce, Linnworks, Xero, HubSpot, and 20+ more)
- `pullpush.connection.test` — Test live connection credentials; returns health metrics and failure count
- `pullpush.connection` — List, get, update, delete, and configure connections (router with actions: list, get, update, delete, health, config)

### Flows

- `pullpush.flow.create` — Wire a source→destination sync pipeline with triggers, mapping, and canonical data models
- `pullpush.flow.dryRun` — Dry-run an event through flow transform/filter without delivery; returns mapped payload
- `pullpush.flow.natural` — Create a flow from a natural-language description; proposes mapping and creates in shadow mode
- `pullpush.flow` — List, get, update, pause/resume, delete flows and view delivery history (router)

### Sync & reconciliation

- `pullpush.sync.reconcile` — Reconcile-and-deliver: diff source vs destination, then deliver changes with per-item progress
- `pullpush.sync` — Preview diffs, snapshot data, inspect single keys, scan catalogs, diagnose unmatched SKUs, manage baselines (router with actions: preview, snapshot, inspect, reconcile, scan, reset-baseline, baseline.history, baseline.rollback, channel-cache, unmatched)

### Field mapping

- `pullpush.mapping.suggest` — AI-proposes field mapping from source sample to target shape; returns mapping, confidence, preview
- `pullpush.mapping.validate` — Validate a mapping config against source and destination schemas
- `pullpush.mapping.compare` — Compare two mappings side by side
- `pullpush.mapping.explain` — Explain how a mapping transforms data, step by step
- `pullpush.mapping.diff` — Diff two mapping versions to see what changed
- `pullpush.mapping.get` — Get a flow's current mapping config, source fields, and destination fields

### Diagnostics

- `pullpush.explain` — Diagnose why a flow, connection, or delivery failed; gathers errors, identifies patterns, suggests fixes
- `pullpush.diagnose.recent` — Scan all flows for recent failures; returns a prioritized issue list
- `pullpush.ask` — Answer natural-language ops questions using tenant failures and anomalies

### Connector authoring

- `pullpush.connector.generate` — AI-generates TypeScript connector code, typechecks, tests, and registers
- `pullpush.connector` — List, get, update, and manage connector definitions (router)

### Data operations

- `pullpush.data.push` — Push file data (CSV, JSON, XML) into a connection
- `pullpush.import` — File-based data import operations (router)
- `pullpush.export` — Scheduled export pipelines: create, list, update, delete, test, run (router)
- `pullpush.canonical` — Inspect and manage canonical data models (router)

### Shadow mode & safety

- `pullpush.shadow` — Run integrations read-only before going live; compare shadow vs live results (router)

### Batch operations

- `pullpush.batch.test` — Test multiple connections in parallel
- `pullpush.batch.status` — Get status matrix across all flows
- `pullpush.batch.setup` — One-call setup: create connections + flow + test in one operation
- `pullpush.batch` — Multi-flow batch operations and proactive reports (router)

### Ops & health

- `pullpush.health.overview` — Tenant health dashboard: connections, flows, failures, backlog, delivery rate, anomalies
- `pullpush.health.mcp` — MCP server health: database, tools registered, uptime
- `pullpush.ops` — Anomaly detection, dead-letter recovery, operation monitoring (router)

### Workflows

- `pullpush.workflow.create` — Create multi-step workflow with trigger and step DAG
- `pullpush.workflow.trigger` — Manually trigger a workflow run from an existing event
- `pullpush.workflow` — List, get, and manage workflows (router)

### Integrations & marketplace

- `pullpush.integration.create` — Create an integration grouping flows/workflows under one name
- `pullpush.integration` — List and manage integrations (router)
- `pullpush.marketplace.install` — Install a marketplace listing into your tenant
- `pullpush.marketplace` — Browse and manage marketplace connectors (router)
- `pullpush.destination.provision` — Provision custom fields on destination API (e.g. HubSpot properties)

### Administration

- `pullpush.tenant` — Tenant management: list, get, create, update (router)
- `pullpush.billing` — Subscription and usage management (router)
- `pullpush.partner` — Partner program operations (router)
- `pullpush.backup` — Backup and restore operations (router)
- `pullpush.feedback` — Submit feedback about MCP tool quality or missing features

Full tool reference: [pullpush.ai/docs/mcp](https://pullpush.ai/docs/mcp)

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PULLPUSH_API_KEY` | Yes | — | Your PullPush API key |
| `PULLPUSH_API_URL` | No | `https://api.pullpush.ai` | API base URL (override for self-hosted) |
| `PULLPUSH_CACHE_DIR` | No | OS cache directory | Where the tool catalogue is cached |
| `PULLPUSH_TIMEOUT_MS` | No | `55000` | How long a tool call may take before the proxy answers with a timeout error |

## Auth scopes

| Scope | Access |
| --- | --- |
| **Tenant key** | Your tenant's connections, flows, sync, diagnostics |
| **Org key** | All tenants in your organization (read or read+write) |
| **Admin key** | Full platform access (billing, partners, all tenants) |

Tools are automatically scoped: a tenant key never sees another tenant's data.

## Features

- **Never dies on a bad connection**: starts even when the API is down, reconnects on its own,
  and serves a cached tool catalogue meanwhile
- **Auto-refresh**: tool catalog refreshes every 5 minutes — new server-side tools appear
  without a restart (clients are notified only when the catalogue really changed)
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

## Development

Development happens in the PullPush platform monorepo; the [Kaduno-systems/pullpush-mcp](https://github.com/Kaduno-systems/pullpush-mcp) repository is a published mirror of each release. Issues are welcome there; code changes land via the monorepo.
