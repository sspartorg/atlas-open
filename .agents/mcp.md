# `@atlas/mcp` — MCP server for agent + item operations

The `@atlas/mcp` package exposes the Atlas tool surface to MCP clients
(Claude Code, Cursor, Claude Desktop, and the CLI agents Atlas spawns). Both
transports register the same tools (`createServer()` → `registerAllTools()`):

- **HTTP (recommended)** — hosted in-process by `@atlas/api` on loopback
  `127.0.0.1:4600/mcp` (`ATLAS_MCP_PORT` overrides). Boot path:
  `packages/api/src/plugins/mcp-host.ts` → `packages/mcp/src/http-handler.ts`.
  One `~/.claude.json` entry serves whichever local stack (dev or prod) is up.
- **stdio (standalone)** — `packages/mcp/src/index.ts`, run from source through
  tsx (`pnpm --filter @atlas/mcp start`, or the `node --import <tsx loader>
  src/index.ts` line in `packages/mcp/examples/claude-desktop-config.json`).
  There is no usable `dist/` entry: `@atlas/shared` ships raw TypeScript.

The server holds **no state** and touches **no database**. It is a thin tool
layer over `@atlas/api` REST routes — `http://127.0.0.1:4301` (dev) or
`http://127.0.0.1:5301` (prod).

---

## Tool surface — 13 tools in 5 groups

Registrations live in `packages/mcp/src/tools/<group>.ts` (`<GROUP>_TOOLS`
arrays), concatenated in `registrations.ts` (`ALL_TOOL_REGISTRATIONS`). The
API's `services/tool-catalog-sync.ts` copies name / group / description into
`tool_catalog` at boot, which the in-app **MCP Tools** page reads
(`GET /api/tool-catalog`) — one source, no drift. Route-level detail is in
`.agents/api-surface.md` → **MCP tool catalogue**.

| Group | Tool | Ops |
|---|---|---|
| AGENTS | `crud_agent` | `op`: search \| get \| create \| update \| delete. Strict `payload` declaring the API's writable fields (incl. `effort`, `kind_slug`, `settings_json`; `memory_cadence` update-only). Delete cascades prompt versions, checklists, memory, tests and agent runs |
| AGENTS | `agent_memory` | `op`: get \| update (`mode`: replace \| append) |
| AGENTS | `marketplace_agent` | `op`: search (filters `query`, `category`, `kind_slug` — the shared `AgentKindSlugSchema` — `limit`) \| get |
| ITEMS | `search_item` | FTS over title + description; `top_k` 1-20 (default 10, sent as `limit`); a query under 2 chars returns `[]` |
| ITEMS | `create_item` | `issue_type`: task \| sub_task; `payload` is a per-kind strict union (task: `project_id`, `title`, …, `repo_ids`; sub-task: `task_id`, `title`, …, `status`), re-checked against `issue_type` in the handler. No assignee |
| ITEMS | `get_item` | Full envelope: item + parent / sub-tasks + project + `repos` + comments + related_links + external_links + activity + agents |
| ITEMS | `update_item` | `action`: patch_fields \| change_status \| add_comment \| add_link \| remove_link \| remove_history |
| ITEMS | `delete_item` | Deleting a Task deletes its sub-tasks |
| PROJECTS | `listProjects` | Project rows (no git fields) |
| PROJECTS | `getProject` | Project + its `repos` (`GET /api/projects/:id/repos`) |
| REMINDERS | `crud_reminder` | `op`: create \| update \| cancel \| pause \| resume \| snooze (`minutes`) |
| REMINDERS | `search_reminder` | Optional `status`, `channel`, `since` |
| NOTIFICATIONS | `sendExternalNotification` | Held through quiet hours, event-key toggle applies; logged in the Notification Log, never the in-app feed. Returns `{ok, sent, held, notification_id, external_status}` |

### What agents cannot do through MCP

Agents never route work, commit, push or record PRs. So there is no MCP op to
assign an item (`update_item` `assign` was removed, and `create_item` takes no
`assignee_agent_id`), to attach or remove external links (`add_external_link`
/ `remove_external_link` removed), or to set `pr_url` / `worktree_branch`
(removed from `patch_fields`). The Owner assigns in the UI; the Task run
commits, pushes, opens the PR and records it. `change_status` stays, but never
sends `?override` (the status-machine override is the Owner's escape hatch in
the web UI), and the API answers 409 while a running Task run holds the Task
(`services/workflow-lock.ts`) — the agent reports via its `atlas-outcome` block.

Also not exposed: guardrails (workspace + project), auto-fetch schedules,
project lifecycle, settings, model registry, comment edit, run spawning.
Guardrails reach agents through the constitution (`buildConstitutionMarkdown()`
in `services/prompt-builder.ts`), not MCP.

`crud_agent` create / update / delete are not caller-checked by the API — the
Owner uses them from Claude Desktop. Agents are told not to by the
constitution's "Forbidden Atlas MCP tool calls" clause (`FORBIDDEN_TOOLS_SECTION`).

---

## Identity and attribution

There is no bound agent identity. The in-process HTTP host serves every agent
on one port, and nothing sets a per-agent env var. Item tools take an
optional, self-declared `agent_id` argument:

- `create_item`, `patch_fields`, `add_link`, `remove_link`, `remove_history`
  send it as `x-atlas-agent-id`; the API (`services/request-actor.ts`) keeps it
  only if it names a real agent, else attributes the write to the Owner.
  On create it is also the default `reporter_agent_id`.
- `change_status` sends it as `requested_by_agent_id`.
- `add_comment` always posts `author: 'agent'` (an MCP caller can't prove it
  is the Owner) with `agent_id`; when that is null, `commentsService.create`
  attributes the comment to the item's live run, if any.

Catalog prompts tell each agent to pass its own id.

---

## Transport details

### HTTP

- `StreamableHTTPServerTransport`, stateless: a fresh server + transport per
  request (the SDK's stateless transport can't be reused).
- **First boot wins** port 4600; a second stack logs that the port is in use
  and runs API-only. `ATLAS_HOST_MCP=false` disables the listener;
  `ATLAS_MCP_PORT` moves it (a test stack that must reach its own DB).
- Loopback only, 1 MiB body cap. The host passes the stack's
  `ATLAS_MCP_TOKEN` into the MCP config, so MCP → API writes carry
  `X-Atlas-Token` and the client needs no auth header.

### stdio

- Diagnostics go to stderr; `console.log` would corrupt the JSON-RPC stream.
- `ATLAS_API_BASE` pins the API — switching dev ↔ prod means editing the
  client config. Set `ATLAS_MCP_TOKEN` for writes.

### How agent runs reach it

Item-attached Claude-dialect runs are isolated from the Owner's config
(`claudeIsolationArgs` in `services/agent-runner.ts`): `--setting-sources
project,local --strict-mcp-config --mcp-config '{"mcpServers":{"atlas":{"type":"http","url":"http://127.0.0.1:4600/mcp"}}}'`
(the URL follows `ATLAS_MCP_PORT`). Runs with no item (the scout agents)
keep the Owner's MCP servers. `allowedToolsFor()` grants `mcp__atlas`.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ATLAS_API_BASE` | `http://127.0.0.1:4301` | Base URL of `@atlas/api` |
| `ATLAS_MCP_TIMEOUT_MS` | `15000` | Per-request HTTP timeout (min 1000) |
| `ATLAS_MCP_TOKEN` | _(empty)_ | Sent as `X-Atlas-Token` on every non-GET request; must match the API's (generated into the root `.env` at first boot). Empty → writes 401 unless the API runs open |

If the API is down, a tool call returns the error with the HTTP status and a
response snippet (4xx prefixed `[atlas-api-NNN]`).

---

## Registering with an AI client

HTTP (start the API once so 4600 is live):

```json
{ "mcpServers": { "atlas": { "url": "http://127.0.0.1:4600/mcp" } } }
```

stdio: see `packages/mcp/examples/claude-desktop-config.json` and
`.agents/testing-mcp.md`.

---

## Hard rules (from `packages/mcp/AGENTS.md`)

- No DB access, no imports from `@atlas/api` / `@atlas/web`; only `@atlas/shared`.
- Every input schema is Zod; descriptions say exactly what the handler does.
- No `console.log`. No retries, caching or circuit breakers.

---

## History

- **2026-07-01 consolidation** — the 35-tool surface became 13 enum-parameterized
  tools (e.g. `listAgents` … `deleteAgent` → `crud_agent`, `createItemLink` /
  `assignItem` / … → `update_item`, `setReminder` → `crud_reminder`);
  `listAgentRuns` was deleted.
- **2026-05-28** — guardrail and schedule tools removed (Owner-only setup).
- **2026-10 audit** — descriptions and schemas aligned with handlers; routing
  and PR ops removed (`assign`, `add_external_link`, `remove_external_link`,
  `pr_url`, `worktree_branch`, create-time assignee); `override`, comment
  `author` and memory `source` params dropped; `search_item` now honours
  `top_k`; `get_item` / `getProject` carry the project's repos.
