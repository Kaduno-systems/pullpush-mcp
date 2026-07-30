# MCP `2026-07-28` migration — `kaduno-pullpush-mcp` (published stdio shim)

> **Status:** Planning. **Do not publish anything until the PullPush server accepts the new
> protocol.** Wait for `@modelcontextprotocol/sdk` 2.x.
> **Estate-wide context and migration order:** `Kaduno-system/docs/platform/mcp-2026-07-28-migration.md`
> **Server-side plan:** `kaduno-pullpush/docs/mcp-2026-07-28-migration.md`
> **Spec:** <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

## What this package is, and why it needs care

A thin stdio → `StreamableHTTPClientTransport` proxy: IDE → stdio → here → HTTPS → PullPush
`/mcp` (`src/proxy.ts:88`). Currently `v2.1.5` on `^1.29.0` of the SDK.

It is **installed on machines we do not control**. That makes version skew the whole problem:
a user's stale copy speaking the old protocol will meet a new host, or a new copy will meet a
server that has not been upgraded yet. Everything else here is trivial by comparison.

## Order of operations — non-negotiable

1. PullPush server (`kaduno-pullpush/packages/mcp`) upgrades and accepts **both** protocols.
2. Verify **this shim, unchanged at 2.1.5**, still works against the upgraded server.
3. Only then bump the SDK here and publish a new major.
4. Only then, after the spec's 12-month window and once download stats show old versions have
   drained, drop old-protocol support server-side.

Publishing this package ahead of step 1 breaks every user at once.

## Work items

- [ ] **Bump `@modelcontextprotocol/sdk` to 2.x.** Both transports (`StdioServerTransport` on
      the near side, `StreamableHTTPClientTransport` on the far side) come from the SDK, so the
      protocol work is the upgrade. Do not hand-roll `server/discover`, `resultType` or MRTR.
- [ ] **Delete the hand-rolled session header.** `src/proxy.ts:38` sets `Mcp-Session-Id` when a
      `sessionId` argument is present. The only caller (`src/proxy.ts:126`) never passes one, so
      it is already dead code — and the header no longer exists in the new spec. Remove the
      parameter with it.
- [ ] **Replace the hand-rolled SSE parse.** `src/proxy.ts:46` finds the first `data: ` line
      and JSON-parses it. That has always been fragile; with stream resumability removed and a
      broken stream now meaning "re-issue as a new request", it should go through the SDK
      client instead of `fetch` + string splitting.
- [ ] **Publish as a major version** (3.0.0). The protocol floor changes, so semver demands it,
      and the major is what tells users a reinstall is required.
- [ ] **Update `server.json`** (MCP registry manifest) with the new protocol version, and
      `README.md` with the minimum server version this shim requires.

## Not affected

No Sampling, Roots, `logging/setLevel`, elicitation or `resources/subscribe`. The whole
deprecation list is a no-op here. The `X-MCP-Client` / `X-MCP-Scope` headers
(`src/proxy.ts:95-96`) are our own and survive unchanged.

## Verification before publishing

1. Old shim (2.1.5) against the upgraded server — must still work. This is the compatibility
   gate; if it fails, the server is not ready and the shim must not ship.
2. New shim against the upgraded server — `tools/list`, one real tool call, and the
   `pullpush://docs/agent-guide` resource.
3. New shim against the **old** server — decide deliberately whether this must work. If not,
   fail with a clear "upgrade your PullPush server" message rather than a protocol error.
