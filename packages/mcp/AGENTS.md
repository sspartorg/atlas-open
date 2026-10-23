# @atlas/mcp — AI Rules

## Responsibility

MCP (Model Context Protocol) server exposing Atlas to AI clients: the Owner's
Claude Desktop / Claude Code / Cursor, and the CLI agents Atlas spawns for Task
runs. **13 tools in 5 groups** (AGENTS, ITEMS, PROJECTS, REMINDERS,
NOTIFICATIONS) — the full list and per-op contract is in `.agents/mcp.md`.

Two transports over the same `createServer()`:
- **stdio** — `src/index.ts`, spawned by a client as a child process.
- **HTTP** — `src/http-handler.ts`, mounted by `@atlas/api`
  (`packages/api/src/plugins/mcp-host.ts`) on `127.0.0.1:4600/mcp`.

The package does **not** access Postgres and does **not** spawn agents. It is a
thin tool layer that calls `@atlas/api` over HTTP.

---

## File Structure

```
src/
├── index.ts          → stdio entry: StdioServerTransport + createServer().
├── http-handler.ts   → HTTP entry: stateless StreamableHTTPServerTransport, one server per request.
├── server.ts         → createServer(config): McpServer + api client + registerAllTools().
├── config.ts         → Reads ATLAS_API_BASE, ATLAS_MCP_TIMEOUT_MS, ATLAS_MCP_TOKEN.
├── api-client.ts     → Typed fetch wrapper. The ONLY file that knows API URLs.
├── registrations.ts  → ToolRegistration type + ALL_TOOL_REGISTRATIONS (read by the API's tool-catalog-sync).
└── tools/
    ├── index.ts         → registerAllTools(server, client).
    ├── agents.ts        → crud_agent, agent_memory, marketplace_agent.
    ├── items.ts         → search_item, create_item, get_item, update_item, delete_item.
    ├── projects.ts      → listProjects, getProject.
    ├── reminders.ts     → crud_reminder, search_reminder.
    └── notifications.ts → sendExternalNotification.
scripts/smoke-test.mjs   → stdio JSON-RPC smoke test (EXPECTED_TOOLS must match the registrations).
```

---

## Hard Rules

- **No direct DB access**, no imports from `@atlas/api` or `@atlas/web`. The only workspace dependency is `@atlas/shared`; reuse its Zod schemas/enums instead of re-declaring them.
- **Descriptions and schemas must match the handler exactly.** Every documented param is in the input schema and used; every returned field named in a description is really returned. Payload objects are `.strict()` so a typo is a validation error, not a silent drop.
- **The SDK needs an object-shaped input schema** (`ZodRawShape`). Per-kind shapes go on a nested field (see `create_item`'s `payload` union) and the handler re-checks the kind.
- **Agents never route work or record PRs.** No assign op, no create-time assignee, no external-link writes, no `pr_url` / `worktree_branch`. Never send `?override` on status changes. The Task run commits, pushes and opens the PR; agents never commit or push.
- **Identity is self-declared**: an optional `agent_id` argument forwarded as `x-atlas-agent-id` (or `requested_by_agent_id` / comment `agent_id`). There is no bound identity — don't document one.
- **Responses** are `JSON.stringify`'d into `content[0].text`.
- **Writes carry `X-Atlas-Token: <ATLAS_MCP_TOKEN>`**; GETs don't.
- **No `console.log`** — it corrupts stdio JSON-RPC. Use `console.error`.
- **No retries, caching or circuit breakers.** If the API is down, return the error.
- Changing a tool or op → update `.agents/mcp.md`, the MCP section of `.agents/api-surface.md`, and `scripts/smoke-test.mjs` if the tool list changes.
