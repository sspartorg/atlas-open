# Architecture

Atlas is a single-owner desktop-style web app for managing AI agents that operate on git repos. It runs entirely on the owner's machine. There is no auth, no multi-user, no cloud database.

---

## Package layout (pnpm monorepo)

```
         ┌────────────────────────────────────────────────────────────┐
         │                       @atlas/shared                       │
         │   types · constants · status-machine · Zod schemas         │
         │   (depends only on `zod`; imported by api AND web)         │
         └────────────────────────────────────────────────────────────┘
                      ▲                                ▲
                      │ imports                        │ imports
                      │                                │
   ┌──────────────────┴───────────────┐     ┌──────────┴──────────────────┐
   │           @atlas/api            │     │         @atlas/web         │
   │  Fastify · Kysely + pg ·         │ ──▶ │  React · MUI · React Router │
   │  Knex (migrations) ·             │HTTP │  TanStack Query · Vite      │
   │  Croner · child_process · zod    │ SSE │  (no DB, no fs access)      │
   │  + SSE                           │     │                             │
   └──────────────────────────────────┘     └─────────────────────────────┘
```

**Hard rule:** `@atlas/web` never imports from `@atlas/api`. They communicate only through `packages/web/src/api/api.ts` over HTTP + SSE.

---

## Dev vs prod local stacks

Atlas runs two isolated local stacks side-by-side. The `ATLAS_ENV` env var
(default `dev`) routes `load-env.ts` (api) and `vite.config.ts` (web) to the
matching env file and downstream config:

| Surface | Dev (default, `pnpm dev`) | Prod (`pnpm prod`) |
|---|---|---|
| Web port | 4300 | 5300 |
| API port | 4301 | 5301 |
| MCP port | 4600 (shared, first-boot-wins) | 4600 |
| Postgres host port | 5600 | 5610 |
| Container | `atlas-open-postgres` | `atlas-open-postgres-prod` |
| Data volume | `atlas-open-pg` | `atlas-open-pg-prod` |
| DB name | `atlas` | `atlas_open_prod` |
| Env file | `.env` | `.env.prod` |

Web reads `WEB_PORT`; API reads `API_PORT` (each with a `PORT` fallback for
E2E). Process diagram below shows the dev stack; prod is the same shape with
the ports / container swapped.

## Process model

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Owner's machine (single process tree)             │
│                                                                        │
│  ┌──────────────────────┐         ┌────────────────────────────────┐   │
│  │   Vite dev server    │         │     Fastify API server         │   │
│  │   (Port 4300 dev /   │         │     (Port 4301 dev /           │   │
│  │    5300 prod)        │         │      5301 prod)                │   │
│  │   serves @atlas/web │ ◀─HTTP─▶│                                │   │
│  └──────────────────────┘         │  ┌──────────────────────────┐  │   │
│                                   │  │ Kysely → pg.Pool         │  │   │
│                                   │  │ Postgres 16 (docker;     │  │   │
│                                   │  │  service `atlas-open-postgres│  │   │
│                                   │  │  on :5600, or            │  │   │
│                                   │  │  atlas-open-postgres-prod on │  │   │
│                                   │  │  :5610 in prod)          │  │   │
│                                   │  └──────────────────────────┘  │   │
│                                   │                                │   │
│                                   │  spawn child_process per task: │   │
│                                   │   • agent-runner   (claude/   │   │
│                                   │     copilot CLI)               │   │
│                                   │   • clone-runner    (git)      │   │
│                                   │   • reclone-runner  (git)      │   │
│                                   │   • delete-runner   (rm -rf)   │   │
│                                   │   • auto-fetch-runner (git)    │   │
│                                   │                                │   │
│                                   │  Croner schedules (in-memory   │   │
│                                   │   registry) for project auto-  │   │
│                                   │   fetch + a 1-min setInterval  │   │
│                                   │   poller for Task run reconcile│   │
│                                   │   + dispatch; both catch up    │   │
│                                   │   missed fires on boot         │   │
│                                   │                                │   │
│                                   │  external notification delivery (HTTPS to   │   │
│                                   │   api.external notification.org)            │   │
│                                   └────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Cross-platform notes

Every spawn point in the process model is a cross-platform binary:

- `docker` / `docker compose` — invoked by `src/scripts/db-up.ts` and `db-down.ts` (pure Node, no PowerShell).
- `git` — invoked directly by `clone-runner.ts`, `reclone-runner.ts`, `auto-fetch-runner.ts`, `git-status.ts`, `git-verify.ts`. `clone-runner` and `reclone-runner` set `GIT_TERMINAL_PROMPT=0` + the GCM-suppressing env vars so credential helpers never pop UI. Every service gets that env from `git-env.ts` `gitInvokeEnv`, which points `GIT_CONFIG_SYSTEM` at a wrapper that includes `/etc/gitconfig` and then resets `credential.helper`: GCM never runs, the Owner's global helper still does, and Git for Windows' `core.autocrlf` still applies at system scope, so a clean CRLF checkout does not read as dirty. The wrapper is written once at boot into the data dir (`system-<hash>.gitconfig`, mode 0600) and rewritten if deleted; with git older than 2.32 (no `GIT_CONFIG_SYSTEM`) or no system config, it sets `GIT_CONFIG_NOSYSTEM=1` instead.
- `rm -rf` is implemented via `fs.rm({ recursive, force })` in `delete-runner.ts`.
- `explorer.exe` / `open` / `xdg-open` — branched per `process.platform` in the `POST /api/projects/:id/repos/:repoId/reveal` handler (ADR 0018: a project has no folder; its repos do).
- `claude` / `gh` (the agent CLIs) — Atlas assumes the user has the right one on `PATH`; the `cli` column on each agent picks which.
- `cli = 'ollama'` is **not** a third binary. Ollama serves an Anthropic-compatible API, so Atlas spawns the same `claude` binary and repoints it with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` from `services/ollama-env.ts` (base URL configurable via `ATLAS_OLLAMA_BASE_URL`, default `http://localhost:11434`). Consequences worth knowing: Ollama runs share Claude's argv, stream-json parsing, `--session-id`/`--resume`, and `~/.claude/projects` transcripts; they record `total_cost_usd = 0`; and the env overlay must always be spread **after** `gitInvokeEnv` so a host `ANTHROPIC_API_KEY` can't divert a free local run to Anthropic. Branch on `CLI_DIALECT` from `@atlas/shared`, never on the raw `cli` value.
- Agent runs on an item (`issueId != null`; `agent-runner.spawnCli`, claude + ollama dialects) are isolated from the Owner's personal Claude Code config. They add `--setting-sources project,local --strict-mcp-config --mcp-config <Atlas MCP only>` (`claudeIsolationArgs`), so no `~/.claude` hooks, plugins, user CLAUDE.md or `~/.claude.json` MCP servers load, while worktree `.claude/commands/atlas-*` still resolve. The prompt stays on stdin because `--mcp-config` is variadic and would swallow a positional prompt. Runs with no item (ad-hoc runs) are exempt because scouts depend on Owner-scoped MCP servers (Playwright plugin, claude.ai Atlassian). Copilot runs are not isolated. Every agent run's child env also carries `ATLAS_API_URL=http://127.0.0.1:<API_PORT>` for `.atlas/scripts` validators. Terminal sessions (`cli-session-host.ts`) and dry runs are unchanged.

Auto-fetch runs in Node on every OS — `auto-fetch-runner.ts` calls the typed `performAutoFetch()` in `services/auto-fetch.ts`, which shells out to `git` via `execFile`. The previous PowerShell holdout (`auto-fetch.ps1`) was retired in C01.

The CORS allowlist + `requireMcpToken` trusted-browser-origin set are computed from `utils/lan-origins.ts`. When `ATLAS_LAN_ACCESS=true`, the helper walks `os.networkInterfaces()` for non-loopback non-link-local IPv4 addresses and adds `http://<ip>:${WEB_PORT}` (dev 4300 / prod 5300) to both sets, plus the machine's mDNS name `http://<hostname>.local:${WEB_PORT}` (lowercased, one `.local` suffix) so LAN browsers can use the friendly name instead of an IP. Vite mirrors this with `server.allowedHosts: ['.local']`. The boot log lists what got added.

### Security — write gate & origin allowlist

> **G-023 (2026-09-21) — the write gate is defence-in-depth, not a security
> boundary.** A request carrying `Sec-Fetch-Site: same-origin` passes it
> without a token, and *any* local client can set that header — proven with
> curl against a running API: `DELETE /api/credentials/<id>` returns 401
> without it and reaches the handler with it. No header-based check can fix
> this, because nothing in an HTTP request distinguishes a browser from a
> local process. It does still stop naive callers and, with CORS, cross-origin
> pages. A hostile process running as the Owner can read `ATLAS_MCP_TOKEN`
> from `.env` regardless, so the token is no stronger against that threat.
> Closing it needs a same-origin bootstrap setting an HttpOnly
> `SameSite=Strict` cookie — an Owner decision, not an improvisation.

The API has exactly one auth gate: a global Fastify `onRequest` hook (`server.ts:76–80`) that delegates to `requireMcpToken` (`plugins/mcp-auth.ts`) for every `POST/PUT/PATCH/DELETE`. The same `getAllowedOrigins()` set feeds `@fastify/cors`, so CORS preflight and the gate agree.

**What is checked**

| Method | Gate runs? | Origin check | Token check |
|---|---|---|---|
| `GET` (reads, SSE) | no | n/a | n/a |
| `POST`/`PUT`/`PATCH`/`DELETE` | yes | `Origin ∈ getTrustedBrowserOrigins()` | `X-Atlas-Token === ATLAS_MCP_TOKEN` |

**What is allowed**

1. **Empty token (`ATLAS_MCP_TOKEN=""`)** — gate is bypassed entirely. **Reaching this state now takes `ATLAS_MCP_TOKEN_OPEN=1`**: `main.ts` generates a 48-byte token at boot when the var is empty and persists it to the root env file, so a fresh install is closed by default (F-021). Only the e2e suite opts out, because it writes over plain HTTP with no browser headers.
2. **Trusted browser origin** — `Origin` header matches the static set (`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}` — dev 4300 / prod 5300) plus, when `ATLAS_LAN_ACCESS=true`, the host's non-loopback IPv4s.
3. **Matching token header** — `X-Atlas-Token` equals `ATLAS_MCP_TOKEN`. This is the path the MCP server uses for write-side calls.

**What is rejected**

Anything else → `401 unauthorized`. The most common case: a second device on the same LAN whose `Origin` is not in the trusted set because `ATLAS_LAN_ACCESS` was left at the default (`false`).

**Trade-off when `ATLAS_LAN_ACCESS=true`**

Any device on the host's LAN can write — fine for home Wi-Fi, **do not enable on public networks**. The boot log (`[security] ATLAS_LAN_ACCESS=true — trusting LAN origins ...`) lists every IP the helper added so the Owner can audit. VPN / virtual adapter IPs are intentionally included; flip the flag back to `false` if any of them is reachable from somewhere the Owner doesn't control.

## Request flow (typical mutation)

```
User clicks button in web
        │
        ▼
useMutation in hook (e.g. useTransitionTask)
        │
        ▼
api.tasks.transition(id, status)         ← packages/web/src/api/api.ts
        │
        ▼  fetch(PATCH /api/tasks/:id/status)
        │
        ▼
Fastify route handler                       ← packages/api/src/routes/tasks.ts
        │
        ▼
Zod schema parse (from @atlas/shared)
        │
        ▼
Service layer                               ← packages/api/src/services/tasks.ts
        │       isValidTransition(...)      ← @atlas/shared/status-machine
        ▼
Kysely query (pg)
        │
        ▼
Response (snake_case JSON, matches @atlas/shared types)
        │
        ▼
React Query invalidates relevant keys (['tasks'], ['issues'], ...)
        │
        ▼
UI refetches and re-renders
```

If the same mutation should ALSO notify external notification or fire an SSE event, the service layer triggers it after the DB write.

Before the handler, a global `preHandler` (`services/workflow-lock.ts`) returns 409 for `PATCH …/:id/status` and `…/:id/assign` while a `running` Task run holds the item — the engine is the only writer of that item's status and assignee until the run parks or stops.

---

## Task runs (agent kickoff)

Agents never start themselves and never route items. In Atlas Open **one agent runs a Task end to end**: assigning an agent to a Task queues it, the dispatcher starts a **Task run**, and `services/workflow-engine.ts` drives it. The run record is a `workflow_runs` row on the built-in `solo` workflow (migration 020) — the names are historical; there is no workflow builder in this edition. One Task = one run = one branch = one PR per changed repo (ADR 0015, `docs/adr/0015-one-task-one-pr.md`).

```
queue  (assign an agent → tasksService.queueIfDraft: draft → ready, kickWorkflowDispatch)
   ▼
dispatch (tick or kick): oldest ready Task with an assignee, no live run, no open depends_on,
         no repo shared with another live run · at most MAX_CONCURRENT_AGENTS (1) holding the slot
   │  startTaskRun: deps gate · insert workflow_runs (graph_snapshot = soloGraph: start → agent → end,
   │                one live run per item) · Task → in_progress
   │  prepareWorktree: ensureWorktree({item:null, branch}) per repo of the Task (branch atlas/task/<id>)
   ▼
spawnNode → spawnAgentRun({workflowRun})
   │  CLI runs in the run's worktree, commits, ends with an atlas-outcome block
   │  runner: completeRun / errorRun / setup_failed / stop / sweep / reaper → onStepFinished
   │     done (+ required checklist rows passed)  → finishRun
   │     asked_question / no outcome / rejected / checklist failed → park
   │     error that looks transient, first try   → retry once after 30 s (retry row carries
   │        parent_run_id = crashed step; its error parks "…errored again after an automatic retry")
   │     setup_failed → park · cancelled → cancel run
   ▼
finishRun → deliver: commit the agent's edits (`<key>: <title>`) · push the branch per changed repo · one PR per repo
            (items.pr_url = first, sibling links in every body) · cleanup worktrees
            Task → in_review (PR opened) | done · one notification · kick dispatch
            push / PR failure → park at End (worktree kept; resume retries delivery)

park   → run waiting_for_owner + park_reason · Task waiting_for_info · Atlas comment + one notification · worktree kept
resume → Owner comment on the Task (comments.ts) or POST /api/workflow-runs/:id/resume:
          refresh the worktree onto the latest default branch, re-run the agent (it reads the reply)
stop   → POST /api/workflow-runs/:id/stop, or stop / delete of the step run:
          cancel the run · kill the step · push committed work (no PR) · Task waiting_for_info
```

**The one-minute tick** (`services/agent-schedule-registry.ts`, started from `main.ts`) only *starts* runs and repairs them: stuck-run watchdog → reminders → quiet-hours flush → GitHub App token refresh → `reconcileWorkflowRuns` (parks a `running` run with no live step for 10 min) → PR-state sync → Jira → `tickWorkflowDispatch`. Parked runs don't hold a slot.

**Instant start.** `kickWorkflowDispatch(reason)` runs a dispatch pass right away, fire-and-forget (it never throws into the caller): when a Task is queued (`tasksService.queueIfDraft`), an assigned Task turns `ready` or any Task reaches `done` (`tasksService.transition` — a `done` may be the last `depends_on` blocker), and at every delivery / stop. All passes — the minute tick and every kick — run one after another on one promise chain, so two passes never race for the same Task. A Task that cannot start goes to `waiting_for_info` with one `workflow.failed` notification, so it never blocks the queue behind it.

**Crashed-step retry.** A step that ends `error` gets one automatic retry before the run parks, unless `isRetryableStepError` (`services/step-error-retry.ts`) calls it permanent: CLI not installed / spawn ENOENT, not signed in / bad key / expired token, no credit, agent missing or inactive. The engine appends `[atlas] Retrying this step automatically at <time>.` to the crashed step's log, stamps `workflow_runs.updated_at` (so reconcile's 10-minute window starts fresh), and after `STEP_RETRY_BACKOFF_MS` (30 s, an in-process timer) respawns the agent with `parent_run_id` = the crashed step — only if the run is still `running` with no live step (a stop during the backoff wins). An API restart during the backoff loses the timer; reconcile then parks the run.

**Failure paths that bypass `completeRun`** all report the step so the run can't hang: `sweepStuckRuns`, the `setup_failed` branch, `POST /api/run/:id/stop`, `DELETE /api/run/:id`, and the `main.ts` orphan reaper (`failOrphanedRuns` flips dead runs to `error`, then `onStepFinished`; it no longer pushes or deletes worktrees). `reconcileWorkflowRuns` is the backstop for anything else.

**Git ops and locks.** `ensureWorktree` / `pushWorktree` / `openPullRequest` / `cleanupWorktreeAfterPush` each take `withProjectGitLock`, which is not re-entrant — the engine never wraps them. The worktree path lives only on `workflow_runs`, never on `items.worktree_path`.

**Concurrency.** `agent_runs_one_live_per_item` (migration 003) allows one `queued` / `in_progress` step per item; `workflow_runs_one_live_per_item` allows one `running` / `waiting_for_owner` run per item and covers the gap between the step and delivery. One agent runs at a time (`MAX_CONCURRENT_AGENTS` = 1, ADR 0033): a Task run or an itemless agent run holds the one slot; everything else waits in `listDispatchQueue()`, shown on `/queue`. **One Task at a time per repo (ADR 0029):** a Task is not started while another run on a Task that names the same repo is `running` or `waiting_for_owner`, so two PRs never edit the same checkout. A parked run keeps its repo until it is resolved.

**Why one agent.** It is the simple model: one agent carries the whole Task in one context window, which is easy to reason about but spends more tokens on a large Task than a chain of narrowly scoped agents would. Multi-agent workflows with scoped context, custom checks and pass/fail loops are the commercial edition (Atlas).

**Ad-hoc runs.** `POST /api/run` (Run-now dialog) spawns one agent with no item in a temp dir: no worktree, no routing, no push. It is how the on-demand catalog agents run and how a prompt is tried.

Off-switches: unassign the agent (a `ready` Task with no assignee is never dispatched), move the Task out of `ready`, or stop the run.

---

## SSE flow (real-time updates)

```
Web client                              API server (single process)
    │                                       │
    │ GET /api/events  (long-lived)         │
    │──────────────────────────────────────▶│
    │                                       │   client added to in-memory
    │                                       │   Set<(SSEEvent) => void>
    │                                       │   (routes/events.ts)
    │                                       │
    │                                       │   30s heartbeat ────┐
    │ data: { "type":"heartbeat" }          │                     │
    │◀──────────────────────────────────────│ ◀───────────────────┘
    │                                       │
    │                                       │   spawn agent-runner
    │                                       │     ├── stdout/stderr → SSE
    │                                       │     │   "agent_output"
    │                                       │     └── on exit → SSE
    │                                       │         "run_completed"
    │ data: { "type":"agent_output", ... } │
    │◀──────────────────────────────────────│
    │                                       │
    │                                       │   auto-fetch-runner fires
    │                                       │     via Croner → SSE
    │                                       │     "autofetch_status"
    │ data: { "type":"autofetch_status",...}│
    │◀──────────────────────────────────────│
```

**Events emitted today** (full catalogue lives in `api-surface.md`):

- Agent run lifecycle: `agent_status`, `agent_output`, `agent_error`, `run_queued`, `run_completed`, `run_error`
- Task runs: `workflow_run_updated` (`workflowId` = `solo`, `workflowRunId`, `workflowRunStatus`, `nodeId`, `issueId`) on start, park, delivery and stop; the web invalidates `['workflow-run', id]` and `['item-workflow-runs', issueId]`. `run_completed` / `run_error` / `agent_status` also invalidate `['workflow-run']` so a run view's step list refreshes
- Data mutations (push instead of poll): `counts_changed`, `notification_created`, `notification_updated`
- Clone: `clone_status`, `clone_output`, `clone_completed`, `clone_error`
- Reclone: `reclone_status`, `reclone_output`, `reclone_completed`, `reclone_error`
- Delete: `delete_status`, `delete_output`, `delete_error`
- Auto-fetch: `autofetch_status`, `autofetch_output`, `autofetch_completed`
- **Theme 08 — Memory regeneration**: `memory_regenerated`
- Commit discipline: `commit_verification`

SSE state is **in-memory only**. Restarting the API drops all subscribers; web clients auto-reconnect.

## Autonomous and project-level runs (Theme 09 / 09b)

Scouts (`kind_slug` ∈ `ai-news | market-research | regulations | jira-to-epic`) and project agents (`agent-ai-readiness`, `agent-knowledge-base`) have no schedule of their own (scheduled runs are a commercial-edition feature). They run **on demand**:

- **Run now** — `POST /api/run { agent_id, project_id? }`: an ad-hoc run in a temp dir, no item.
- **As a Task** — assign the agent to a Task like any other; its run gets a worktree, pushes and opens a PR.
- **Prompt** — `prompt-builder` renders the constitution, the role with `{{ key }}` substitution against `settings_json` and the outcome contract, then either the item context, `# Project Context` (name, description, guardrails, every Task + spec) when the run has a project, or a `# Project-level Run` paragraph when it doesn't, then output instructions and self-memory. Agents read `.atlas/outcome.md`, `.atlas/self-memory.md` and `.atlas/changed-files.md` from the working directory — the last is the branch diff against the merge-base, staged so an agent does not rediscover it by crawling the repo.
- **Created items** — Tasks a scout creates (Jira import, market research) land as `draft` and stay put; nothing routes them. The Owner assigns an agent to queue them.

### "Generate AI scaffold"

```
Owner clicks "Generate AI scaffold" on Project Detail
            │
            ▼
POST /api/projects/:id/generate-ai-scaffold  { repo_id? }
  - precondition: the repo's clone_status='ready' + credential_id set (else 409)
  - install agent-ai-readiness if missing
  - create Task "Make this repository AI-ready" on that repo, assignee = agent-ai-readiness
    → assigning queues it → 202 { task_id }
            │
            ▼
Task run: branch atlas/task/<id>, worktree, the agent writes the missing scaffold files
(AGENTS.md, CLAUDE.md, Copilot instructions, .agents/) and commits
            │
            ▼
delivery: push branch · open PR · cleanup worktree · Task → in_review · one notification
```

The agent does NOT run typecheck/test/build — the PR review IS the validation. It never overwrites files on `origin/main`. Push and PR use the repo's stored credential through the engine's per-call git config.

### Freshness model: push primary, focus-refetch fallback, short cache

There is **no periodic polling** in the web today. Liveness comes from three channels:

1. **SSE invalidation** while the tab is foreground — service-layer mutations call `broadcastSSE()` after every DB write, the web's `useSSE` handler maps each event to a TanStack Query `invalidateQueries(...)` call, the affected hook refetches.
2. **`refetchOnWindowFocus`** + **`refetchOnReconnect`** — TanStack Query defaults catch any drift after a tab has been backgrounded long enough that SSE may have raced an auto-reconnect.
3. **Bounded staleness via `staleTime: 30 s` + `gcTime: 5 min`** (`packages/web/src/App.tsx` QueryClient defaults). A navigation within 30 s paints from cache and skips the network entirely; SSE still drops cached entries the moment data actually changes server-side, so the 30 s window only ever holds data that was correct the last time the server said so. This replaced the previous "every read is treated as stale" model, which was re-firing the same query on every page mount and pushing cold reload past 1.5 s.

A few hooks override the global defaults with `staleTime: Infinity` + `refetchOnMount: false` because their data only changes through local mutations (which write through `setQueryData` / `invalidateQueries` immediately) or SSE: `useSettings`, `useSidenavCounts`, `useAgents`, `useProjects`. `useAiEnabled` is a passthrough that calls `useSettings` so it never double-fetches the same `['settings']` key.

If you add a new mutation in the API, you MUST `broadcastSSE()` after the DB write (typically `counts_changed`, or a more specific event if one fits). Otherwise the UI will not update until the user switches tabs. See `AGENTS.md` self-update rules.

### Page-chunk prefetch on hover

`packages/web/src/utils/prefetchRoute.ts` exposes `prefetchRoute(key)` which dynamically imports the page's lazy chunk. `Sidenav`, `BottomNav`, and `MoreSheet` call it from `onPointerEnter` on each nav item, so by the time the user actually clicks, the chunk is already resolved. Each chunk is primed at most once per session. Combined with Vite's `optimizeDeps.include` (which pre-bundles MUI, react-router, react-query and the React runtime), this turns subsequent navigations into pure render exercises rather than module-fetch waterfalls.

---

## Subprocess lifecycle

All long-running work runs in spawned subprocesses, never inline in the request handler. Inline execution would block the Fastify worker and lose the granular stdout/stderr the SSE stream relies on for progress feedback.

| Runner | Spawns | Inputs | Outputs |
|---|---|---|---|
| `agent-runner.ts` | `claude` or `copilot` CLI (`cli = ollama` spawns `claude` with the Ollama env overlay) | prompt built from agent `prompt_md` + issue context; `.atlas/*` staged in the Task run's worktree or a temp dir | stdout → `agent_output` SSE; on exit, cost + outcome persisted and the step reported to `workflow-engine.onStepFinished` |
| `clone-runner.ts` | `git clone` | repo URL, credential (decrypted in-memory), target path | output → `clone_output` SSE; on success, project `clone_status` → cloned |
| `reclone-runner.ts` | `git stash` + `fetch --prune` + `pull --ff-only` | repo_id | sequence of SSE events |
| `delete-runner.ts` | `rm -rf` (workspace folder) | project_id | SSE events |
| `auto-fetch-runner.ts` | `git fetch` | scheduled via Croner from `project_schedules` | SSE events + external notification on auth failure |

Auth-failure escalation: `auto-fetch-runner.ts` detects HTTP 401/403 in git output and queues a external notification through the notifications service (respects quiet hours).

### Terminal PTY streaming (WebSocket, not SSE)

Terminal sessions are the one subprocess surface that does NOT stream over SSE. `services/cli-session-host.ts` keeps each `claude`/`copilot` CLI alive in a ConPTY and pipes bytes over WS `/api/cli/sessions/:id/stream` (binary frames both ways). Every PTY byte is also parsed into a per-session `@xterm/headless` mirror (`services/terminal-screen-state.ts`); live broadcast happens in the mirror's write callback, and a browser attach replays `serialize()` of the mirror as its first frame. That ordering (feed callbacks FIFO with the attach flush marker) guarantees an attaching browser sees every byte exactly once — inside the snapshot or live, never both — and the snapshot is always a well-formed VT stream with no embedded DSR queries, laid out at the pinned `TERMINAL_COLS × TERMINAL_ROWS` grid (120×30, `@atlas/shared`) that PTY, mirror, and every browser pane share for the whole session lifetime (no resize path exists; panes scale their font to fit). The browser side (`TerminalXterm.tsx`) is a dumb pipe: raw frame bytes go straight into xterm.js's stateful parser, with no client-side decoding or buffering. SSE still carries the session's metadata events (`cli_session_status`, cost rollups) — bytes and metadata ride separate channels.

---

## Onboarding gate

`packages/web/src/App.tsx:61-88` defines a route guard:

- `!settings.onboarding_complete` → forces `/onboarding`, blocks all other routes
- `settings.onboarding_complete && pathname === '/onboarding'` → forces `/`

Everything inside `AppShell` (Sidenav + Topbar + Outlet) is post-onboarding only. The gate exists because every other surface assumes a workspace path and an Owner name; rendering them without those values produces broken empty states rather than a useful first-run experience.

---

## Navigation loading curtain

Inside the AppShell, the scrollable content `Box` (`packages/web/src/App.tsx`) renders two siblings working together:

1. `<Suspense key={location.pathname} fallback={<BrandedFallback />}><Outlet /></Suspense>` — the React Router outlet, with the Suspense boundary **keyed by `pathname`**. Keying forces a fresh Suspense boundary on every path change, so React shows the fallback for the full duration of the lazy-chunk load instead of keeping the previous page visible (React 18's default "stay on the old state on update suspension" behavior).
2. `<NavigationCurtain />` (`packages/web/src/components/shell/NavigationCurtain.tsx`) — a URL-driven overlay that paints `<BrandedFallback />` for 350 ms on every **`pathname`** change. Query-param changes (`?tab=`, `?status=`, etc.) deliberately do not trigger it.

Both are keyed by `pathname` only, with deliberate division of labour:

- **Path change** (sidenav → Agents, row click → detail page, programmatic `navigate()`): keyed Suspense remounts the boundary and paints `BrandedFallback` for the full chunk-load duration; the curtain overlays a 350 ms flash on top for snappy click feedback. Both fire.
- **Same-path tab / filter change** (`?tab=`, `?status=`, search filters): neither mechanism fires. The page stays mounted, scroll position and form state are preserved, and tab content swaps via local `useState` (see in-page tab strategy below) rather than going through React Router on the click path.

Together they guarantee a visible loader the moment the user navigates to a new page, while keeping tab switches and filter changes feeling instant and stateful.

The curtain is an overlay (`position: absolute`, not a route remount). The keyed Suspense, by contrast, *does* unmount the previous page on path change — that's correct, because the previous page is no longer relevant.

Modal-gated `<Suspense fallback={null}>` boundaries inside pages (e.g. `ProjectDetail` delete / env-secrets modals, `Issues` new-issue modal, `Credentials` edit modal) are intentionally untouched — they open via component-local `useState`, not navigation, and a full-screen logo behind a dialog backdrop would be wrong.

---

## In-page tab strategy: lifted data + Container + Content split

Pages with tab strips (`ProjectDetail`, `AgentDetail`, `Notifications`) split every tab into a lightweight **Container** and a heavy **Content** component, gated by `useDeferredMount`. **The parent page owns all data fetching for every tab** — Containers and Content components never call `useQuery` themselves; they receive data as props.

### How a tab click flows

1. Tab state is driven by `useTabParam` (`packages/web/src/hooks/useTabParam.ts`), a thin `useState` wrapper. The initial value is read once from `window.location.search` (deep links to `?tab=…` still work). Clicking a tab is a single `useState` update — no `useSearchParams`, no `useLocation`, no router subscription anywhere on the click path. (`AppShell`, `Sidenav`, `Topbar` all consume router state; routing the click through the URL was re-rendering the whole shell.)
2. The parent unmounts the previous tab's Container and mounts the next tab's Container. **No new `fetch` request fires** — the data is already in the parent's TanStack Query observers.
3. The Container synchronously returns a per-tab `<TabNameSkeleton />`. React commits, the browser paints the skeleton.
4. After `useDeferredMount` fires (`setTimeout(0)` from a `useEffect`), the Container re-renders. For tabs the parent had to fetch (`OverviewTab`, `TasksTab`, `MemoryTab`, both Notifications tabs), the Container also waits for `data !== undefined` from props. The first time the page is mounted the wait is for the parent's initial fetches; subsequent tab swaps see data immediately.
5. The Container renders `<TabNameContent data={…} {...rest} />` — pure render, no fetch, no chunk download.

### Data fetched in each parent

- `AgentDetail`: `useAgent(id)`, `useAgents()`, `useAgentRuns(id)`, `useAgentMemory(id)`. The last one is lifted from the old `MemoryTab`.
- `ProjectDetail`: `useProject(id)`, `useAgents()`, `useSettings()`, `useProjectCounts(id)`, `useIssues({ projectId: id })`. The Tasks tab's rows (`tasks` + a client-side `sub_task_count`) and the rail's active agents are derived from the one issue-tree fetch.
- `Notifications`: `useSettings()`, `useNotifications({ external_status: 'sent', limit: 1 })` (top stamp), `useNotifications({ limit: 200 })` (single dataset both tabs filter client-side), `useAgents()`. The `{ limit: 200 }` set and `useAgents` are lifted from the two tabs.

### Page-level Refresh button

`packages/web/src/components/RefreshButton.tsx` is a small icon-button component that takes `{ onRefresh, isFetching, tooltipLabel }`. Each tabbed page renders one in its header and wires `onRefresh` to `queryClient.invalidateQueries` for the relevant prefixes, plus `useIsFetching` (predicate or queryKey) for the spinner state. Because the parent owns the queries, this single button refetches everything every tab consumes.

### Why this layout

- React 18 does not yield between a synchronous state update and the commit. Without `useDeferredMount`, the heavy Content render happens on the click frame and blocks paint. With it, the skeleton paints first; the heavy mount happens on a later macrotask, off the click→paint loop.
- Lifting fetches removes per-tab fetch latency and per-tab chunk-download latency (the prior `lazyNamed` split has been dropped on `GuardrailsTabContent`, `MemoryTabContent`, `PromptTabContent`; they are now eager-imported). After the first paint, tab swap is purely a render exercise.
- The parent chrome (`ProjectHeader`, `ProjectRightRail`, `AgentHero`, `AgentSidebar`) is wrapped in `React.memo` and receives `useCallback`-stabilised handler props from the parent. A tab click no longer re-walks 800+ LOC of header/sidebar JSX.
- Conditional rendering of the active tab body (`{currentTab === 'tasks' && <TasksTab … />}`) is intentional: a previous "mount-all + CSS hide" attempt made hidden tabs re-render on every parent update, which turned heavy panels into perceptible lag.
- `AgentDetail.setTab` is **not** wrapped in `useTransition` — wrapping would tell React to keep the old tab body visible until the new one is ready, which produces a different "click does nothing for a second" feel.

### Trade-offs accepted

- A page reload returns to the tab's default value (the URL no longer reflects the current tab while the user is on the page).
- Browser back does not restore tab state.
- Initial page load is heavier: every lifted query fires in parallel on parent mount instead of one-per-tab on click.
- Initial bundle for `AgentDetail` and `ProjectDetail` is larger now that the four previously-lazy Content components ship eagerly.
- In-page links that previously navigated to `?tab=…` (e.g. the "Guard-rails active" badge in `ProjectHeader`) now call the same `setTab` callback the tab strip uses; they are buttons, not `RouterLink`s.

### File layout

For every tab `TabName.tsx`, there is a sibling `TabNameContent.tsx`. The Container holds the per-tab skeleton, the `useDeferredMount` gate, and the prop-passthrough to Content. The Content holds all the heavy JSX. Local component state (e.g. `GuardrailsTabContent`'s `draft`, `MemoryTabContent`'s editor state) lives inside Content; the Container only re-evaluates the skeleton gate on tab activation.

---

## Bundle size baseline

Captured 2026-05-27 at commit `dd90e93` (B02 verification pass) against the
`packages/web/vite.config.ts` settings (`manualChunks` for mui / query / router,
`sourcemap: false`, `optimizeDeps` pre-bundle list). Pages are code-split via
`lazyNamed`; modals are individually chunked.

| Chunk | Raw (KiB) | Gzip (KiB) |
|---|---:|---:|
| `mui` (vendor) | 401.50 | 122.89 |
| `index` (app shell + theme + components used app-wide) | 359.13 | 104.25 |
| `router` (vendor) | 41.81 | 14.92 |
| `query` (vendor) | 39.23 | 11.60 |
| `AgentDetail` (largest page) | 79.12 | 21.18 |
| `ProjectDetail` | 34.56 | 9.52 |
| `Search` | 31.42 | 8.70 |
| `Settings` | 29.15 | 8.96 |
| `NewProjectModal` (largest modal) | 27.74 | 8.07 |
| `IssueDetailShell` | 23.10 | 7.06 |
| `Notifications` | 20.99 | 5.91 |
| `Dashboard` | 17.90 | 5.47 |
| `Agents` | 17.62 | 6.10 |
| `Projects` | 17.37 | 6.05 |

Initial cached core (mui + index + router + query) ≈ **254 KiB gzip** (was 243
KiB at 2026-05-23 `8dfcd40` — `+4.5%` from MUI minor uptake + app-shell growth
across A04 / A05 / Theme 09b shipments). All chunks remain well under any
single-chunk budget (largest is `mui` at 122.89 KiB gzip). Refresh this table
when `manualChunks` strategy changes. Treat a >10% growth on any cached-core
chunk as a regression worth tracing — those bytes hit every cold load. Lazy
pages may move more freely; the only notable lazy-page mover this pass was
`AgentDetail` (17.19 → 21.18 KiB gzip, `+23%`) which absorbed the A04
reset-rounds banner and A05 run pill on the Runs tab.

---

## Storage layout

- **Database**: SQLite file (`atlas.db`) inside the workspace folder selected during onboarding. Schema in `packages/api/src/db/migrations/*.sql` (11 migrations as of writing — see `api-surface.md`).
- **Repos**: cloned under the workspace folder, one subfolder per project.
- **`.env`**: the API mirrors the `settings.env` table into a `.env` file in the server folder on every save (powered by `packages/api/src/services/env-file.ts`).
- **External notification secrets**: token stored encrypted at rest (AES-256-GCM); decrypted only in-memory by `services/external notification.ts`.
- **Git credentials**: same encryption approach — `credentials` table + `services/credentials.ts`.

---

## Key non-obvious invariants

- The status machine is the **only** authority on valid transitions. UI hides invalid actions; API rejects invalid PATCHes. Both call `isValidTransition()` / `getValidNextStatuses()` from `@atlas/shared`.
- Task runs escalate **only** to the Owner (park → `waiting_for_info`); agents never route items. The engine is the only writer of an item's status + assignee while its Task run is `running` (`workflow-lock.ts` 409s the PATCH routes, UI and MCP alike).
- `ATLAS_AI_ENABLED=false` puts `agent-runner.ts` into a simulated mode that emits canned output ending in an `atlas-outcome: done` block, so Task runs still advance — used for development without burning CLI credits.
- Clones run with credentials injected via `http.extraheader` (Basic auth), NOT via URL-embedded credentials, because Windows Git Credential Manager will leak URL-embedded tokens.
