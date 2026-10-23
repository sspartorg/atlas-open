# Data Model

> **2026-05 â€” Postgres migration in progress.** The DB engine is now Postgres 16 (docker compose service `atlas-open-postgres`, host port 5600 â†’ container port 5432). Schema is a single Knex migration: `packages/api/src/db/migrations/001_baseline.ts`. Items live in a **single `items` table with a `type` discriminator** and a `parent_id`/`parent_type` pair. Since migration 037 (ADR 0015, `docs/adr/0015-one-task-one-pr.md`) there are exactly two kinds: `task` (top level) and `sub_task` (a Task's child); epics became Tasks and stories / bugs / sub-bugs became sub-tasks. The legacy polymorphic side tables (`comments`, `issue_events`, `agent_runs`, `notifications`) now use a single `item_id` FK to `items` with `ON DELETE CASCADE`. The link table is renamed `item_links` and carries a `relation_type` column (`relates_to` or `depends_on`). The entity descriptions below document the per-kind API contract (`/api/tasks`, `/api/sub-tasks`); the storage shape is unified.

**`priority` lives on both item kinds** (`low | normal | high | urgent`, default `'normal'`); the detail-page right rail's `<DetailsRailCard>` renders a priority chip wired to the kind's update mutation.

**2026-05-19 â€” `depends_on` UI is live.** `item_links.relation_type` partitions into "Blocked by" (depends_on) and "Relates to" (relates_to) sections on every item detail page (`<RelatedItemsCard>`). The server enforces blocker semantics in `services/dependency-guard.ts` â€” transitions into `in_progress` / `in_review` fail with "blocked by" errors until upstream items complete.

Authoritative types live in `packages/shared/src/types/index.ts` (`ITask`, `ITaskListItem`, `ISubTask`, `ITaskFullResponse`, `ISubTaskFullResponse`, `IIssueTreeNode` / `IIssueTreeResponse`) plus the new `packages/shared/src/items/types.ts` (`IItem`, `IItemLink`, `ItemRelation`). Constants and label maps in `packages/shared/src/constants/index.ts`. Status transitions in `packages/shared/src/status-machine/index.ts`; depends-on enforcement helper in `packages/shared/src/status-machine/blockers.ts` (`assertCanStart`). Zod validators in `packages/shared/src/schemas/index.ts`. Migrations in `packages/api/src/db/migrations/001_baseline.ts`.

**Naming rule:** API responses use snake_case (matching DB columns). TypeScript interfaces use snake_case field names too â€” there's no transformation layer. `IProject`, `IAgent` (`I` prefix), TypeScript types use PascalCase.

## Depends-on relation (new)

Items can be linked via `item_links(from_id, to_id, relation_type)`:
- **`relates_to`** â€” semantically undirected. The service normalizes pairs so `(A,B)` and `(B,A)` collapse onto one row. Surfaces a "Relates to" section on the detail page.
- **`depends_on`** â€” strictly directed. `from depends_on to` means "from is blocked by to". Cycle detection (recursive CTE) rejects edges that would close a `depends_on` cycle. While any blocker isn't `done`, the dependency-guard refuses transitions out of `ready`/`draft` to `in_progress`/`in_review` (escalations to `waiting_for_info` are still allowed). When the last blocker resolves, `notifyDependentsUnblocked(itemId)` emits an `unblocked` issue_event on every dependent.
- **B04 — depends_on is also hard-gated at run start.** `workflow-engine.startTaskRun` calls `assertDepsAllDoneForDispatch(itemId, agentId)` once, before inserting the `workflow_runs` row. If any `depends_on` target is non-`done` (including `in_review` — `done` is the only terminal status; there is no `closed`), it throws `DependenciesNotReadyError` and records a `dispatch_blocked` issue_event on the item. The dispatcher never picks such a Task (`oldestReadyItem` skips it), and `POST /api/workflow-runs/:id/resume` surfaces it as `409 {details:{blockers}}`. A running Task is not re-gated, and engine status writes (`in_progress`, `in_review`, `done`) bypass `assertNoOpenBlockers`. Companion change in `services/prompt-builder.ts`: the `## Related items → ### Depends on` section bakes each dep's description + acceptance_criteria into the prompt up-front so the agent doesn't need to MCP-fetch the dep mid-run.

**B05 â€” who creates links, and how.** Link creation has two paths and **no runner-side auto-link**:

1. **UI path (Owner-driven).** The detail-page `<RelatedItemsCard>` posts to `POST /api/issues/:type/:id/links`, which calls `services/item-links.ts::itemLinks.create(fromId, toId, relation)`. That service runs cycle detection on `depends_on`, normalises pair order on `relates_to`, is idempotent (re-creating returns the existing row), and writes an `item_link_created` activity event on **both** endpoints.
2. **Agent path (discretionary).** Agents call the MCP `update_item` tool with `action: 'add_link'` (`packages/mcp/src/tools/items.ts`), which hits the same REST route as the UI. Link creation is **at the agent's discretion based on the tool description** â€” performer and reviewer prompts do not carry a Working Protocol bullet instructing the agent to link (contrast: `agent_memory` `op: 'update'` does carry such a bullet â€” see `.agents/api-surface.md`). An agent that notices a missing dependency may choose to call `add_link`; nothing in the prompt or runner mandates it. Per-agent tool gating was removed post-`253c43d` / B14; the constitution's `FORBIDDEN_TOOLS_SECTION` is the only runtime check.

The read-side is also worth noting: `services/prompt-builder.ts::buildLinkedItemsSection(itemId)` injects every existing link (`### Depends on`, `### Blocks`, `### Relates to`) into the calling prompt up-front, so the agent doesn't need to call `listItemLinks` mid-run to see what's already attached. There is no post-run heuristic that parses agent output to *infer* new links â€” the only writers are the UI route and the `createItemLink` MCP tool.

---

## Entities

### Owner (implicit)
Not a table. Always one. The "Owner" is the human running the app. Stored in `settings.owner_name` + `settings.accent_color`. A Task run escalates (parks) to the Owner only; agents never route items.

### IAgent
**Why this entity exists**: An agent is a reusable AI worker definition (CLI + model + effort + prompt + memory + checklists). It carries no schedule, routing or git-delivery state — the Task runner owns delivery. A Task's `assignee_agent_id` names the one agent that runs it end to end.

AI agent profiles. **Not seeded** — a fresh DB has zero agents; each row is created by installing a marketplace catalog entry (`/agents/marketplace`, `POST /api/marketplace/agents/:id/install`), which also copies the entry's checklists.

Fields (`IAgent`): `id, name, category, cli, model, effort, framework, prompt_md, prompt_version, status, accent_color, sort_order, description, designation, role_id, glyph, memory_cadence, kind_slug, settings_json, marketplace_source_id, marketplace_pulled_version, created_at, updated_at`

- `category` ∈ `software-dev | marketing | content | design`
- `cli` ∈ `claude | copilot | ollama` (migration 029 widened the CHECK)
- `status` ∈ `active | inactive` (pause/resume toggle). Assigning an unknown or inactive agent is a 400.
- `prompt_version` increments on each prompt edit; history lives in `agent_prompt_versions`.
- `accent_color` is a hex string used for chips/avatars
- `description` is the free-text blurb shown on cards and the Overview tab; editable from the Overview tab.
- `glyph` is a Material Symbols icon name used on the card avatar + agent chips; editable via the Identity panel's "Replace glyph" picker. Empty falls back to a per-category default.
- **Identity + lifecycle columns**:
  - `designation` — human-readable role label (e.g. "Product Owner", "Code Review Lead"). Shown next to the agent name in the Sidebar identity panel. With A08 it acts as an optional **per-agent display override** on top of `role_id`; empty falls back to the role's canonical label (then category).
  - `role_id` — A08. FK into the SDLC role catalog (`roles.id`, `ON DELETE SET NULL`, indexed `idx_agents_role_id`). NULL on autonomous agents (ai-news, market-research, regulations, jira-to-epic, ai-readiness, knowledge-base). Every agent this edition's catalog ships (including `agent-solo`) has `role_id = NULL`.
  - **Removed columns:** `kind` / `reviewer_agent_id` (migration 019); `handoff_prompt_md`, `max_rounds`, `requires_item`, `requires_worktree`, `push_code`, `raises_pr`, `schedule_*`, `cron_expr`, `concurrent_runs`, `last_run_at`, `next_run_at` (migration 036).

**Related tables:** `agent_checklists` (the agent's quality gate: required rows must come back `passed` in the `atlas-outcome` checklist, or a `done` routes as a fail), `agent_memory` (one row per agent — procedural-memory markdown), `agent_prompt_versions` (append-only prompt history). Migration 036 dropped `agent_handoff_rules`, `marketplace_agent_handoffs` and `agent_round_counts`.
> ⚠️ **An empty required checklist is an automatic pass.** `agent-runner-outcome-routing.ts` returns `apply_on_pass` when `requiredChecklist.length === 0`, so an agent with no rows can never fail its gate. Rows are also **self-reported**: the router trusts `item.passed` from the agent's `atlas-outcome` block and never re-runs the guardrail script whose exit code the row describes. A catalog checklist change only reaches installed agents when `manifest.json`'s `version` is bumped — `services/marketplace.ts:224-225` gates `upgrade_available` on `installed_version < catalogVersion` — and the Owner then accepts the `checklists` field.


### IRole (A08 â€” SDLC role catalog)
**Why this entity exists**: A lookup table of agent roles (10 rows seeded by `001_baseline.sql`), the FK target of `agents.role_id`. Read by the Agents page Role filter chip and the AgentCard subtitle fallback; edited by the Owner via `PATCH /api/roles/:id` to update curated default prompts without touching any existing agent. The catalog *shape* is governed by the `SdlcRole` enum in `@atlas/shared` â€” runtime rows mirror that enum, they don't extend it.

Fields: `id, label, description, default_prompt_md, default_status, sort_order, created_at, updated_at`

- `id` is the slug (e.g. `'engineer'`), PRIMARY KEY, FK target for `agents.role_id`.
- `default_status` âˆˆ `'active' | 'inactive'` (DB CHECK). **Seed-time policy only** â€” the catalog never re-disables a runtime-enabled agent.
- `default_prompt_md` is the role's curated starter prompt. The runner reads from the agent row, never from the catalog, so edits to the role default don't propagate to existing agents.


### IAgentPromptVersion
**Why this entity exists**: Every `prompt_md` edit on an agent gets a row here, so the Prompt tab's "Version history" can survive across machines and the Owner can revert a regression. The currently-active version is whatever `agents.prompt_version` points at; older rows are kept indefinitely. Revert never mutates a historical row â€” it appends a NEW row at the next version whose `reverted_from` links back to the source.

Fields: `id, agent_id, version, body_md, edited_by, reverted_from, created_at`

- `agent_id` FK â†’ `agents(id)` ON DELETE CASCADE
- `(agent_id, kind, version)` is UNIQUE (kind partitions the performer vs reviewer histories under the two-persona model)
- `kind` âˆˆ `'performer' | 'reviewer'` (DB CHECK), DEFAULT `'performer'`. Added by migration 020 alongside the `agents.reviewer_prompt_version` column.
- `reverted_from` is null on first-time saves, set to the source version on revert

### IAgentMemory
**Why this entity exists**: Procedural memory captures *self-corrections* â€” what the agent learned from past runs ("don't bounce empty AC", "prefer concrete actors over 'user'"). It lives next to the agent rather than in the prompt body so the Owner can edit it without churning the prompt version. One row per agent (`agent_id` is the PK), so reads never have to branch on "first-ever access" â€” `GET /agents/:id/memory` auto-creates an empty row.

Fields: `agent_id, body_md, version, source, last_run_id, runs_since_regen, updated_at`

- `agent_id` FK â†’ `agents(id)` ON DELETE CASCADE
- `source` âˆˆ `ai-generated | manual-edit` â€” flips back to `ai-generated` on every regenerate, flips to `manual-edit` on every PUT.
- `version` increments on each PUT and each regenerate
- `last_run_id` FK â†’ `agent_runs(id)` ON DELETE SET NULL; the run that triggered the most recent regeneration (null until first regenerate, or after that run is deleted)
- **Theme 08 â€” `runs_since_regen`**: counter incremented per completed/errored run (errors count double â€” they carry more signal). When this reaches `agents.memory_cadence`, `maybeRegenerateAfterRun()` fires a cadence regen and resets to 0.

### Theme 08 â€” Memory boundary rule, lifecycle, and audit

**Memory boundary** (`MEMORY_BOUNDARY_RULE` const in `services/agent-memory.ts`, embedded into the regenerate prompt and the `agent_memory` MCP tool description verbatim):

> Memory is for *behavioral generalizations* of how the agent should approach future similar work â€” process, style, anti-patterns, escalation triggers. It is NOT for product or project facts. Test: "would this fact be just as true if a different item or different project hit this code path?" If yes â†’ memory. If tied to project X / item Y / specific user â†’ does NOT belong; project-specific facts go in item comments or spec_md.

**Memory lifecycle (Theme 08)** â€” four triggers fire memory writes:

1. **Manual** â€” Owner clicks "Regenerate from runs" in the Memory tab, or the POST `/api/agents/:id/memory/regenerate` route is called directly.
2. **Cadence** â€” `agent-runner.completeRun/errorRun` calls `agentMemoryService.maybeRegenerateAfterRun(...)`. It increments `runs_since_regen` (by 2 on error, by 1 on success), and fires regen when the count reaches `agents.memory_cadence`. Counter resets on regen.
3. **High-signal** â€” `maybeRegenerateAfterRun` also scans the most recent Owner comment on the run's item for `[lesson:]` or `[memory:]` markers. If present, regen fires immediately regardless of cadence.
4. **A06 â€” Agent self-draft (`mcp_update`)** â€” Working Protocol bullet #5 (performer) and the symmetric "End-of-run memory draft" section (reviewer) direct agents to call `agent_memory` (`op: 'update'`, `mode: 'append'`) when they noticed a *generic behavioral lesson*. Agents only fire it when warranted; the cadence regenerator is the safety net for runs that don't. The memory tool is the MCP `agent_memory` tool (`op: 'get' | 'update'`).

`regenerate()` acquires a session-scoped `pg_advisory_lock` keyed on the agent id so two regens for the same agent can't race. The second concurrent call no-ops and returns the current memory row.

**Memory writes from MCP** â€” the `agent_memory` MCP tool (`op: 'update'`) supports two modes:
- `mode='replace'` (default) â€” overwrites the whole body via PUT; equivalent to the legacy behaviour.
- `mode='append'` â€” surgical append of a single bullet under `## Course corrections`. Calls `agentMemoryService.appendLesson(...)` which bumps `version`, audits with `trigger='mcp_update'`, and does NOT reset the cadence counter.

**A06 â€” soft boundary-rule filter** â€” every audit row carries `boundary_flags: string[]` populated by `detectBoundaryViolations()` against the new body. Flags: `item_id` (matches `epic_â€¦|story_â€¦|sub-task_â€¦|sub-bug_â€¦|bug_â€¦|task_â€¦`), `agent_id` (`agent-*`), `project_id` (`proj_â€¦|project_â€¦`), `run_id` (UUID). Soft â€” memory still persists (Owner's choice); the Memory tab renders an amber "BOUNDARY" chip on non-empty rows so drift is visible. Heuristic only â€” no DB-side reject.

### IMemoryRegeneration (Theme 08 audit log)

**Why this entity exists**: The Memory tab shows a sparkline of when memory shifted and by how much. The audit row captures every regen â€” trigger source, version delta, byte-diff metrics â€” so the Owner can tell at a glance whether the agent is learning healthily (regular cadence rows + occasional high-signal) or stuck (no rows in weeks despite many runs).

Fields: `id, agent_id, run_id, trigger, prev_version, new_version, prev_body_hash, new_body_hash, chars_added, chars_removed, boundary_flags, created_at`

- `trigger` âˆˆ `manual | cadence | high_signal | mcp_update` (CHECK constraint)
- `run_id` is nullable â€” manual regens have no run; `mcp_update` rows may carry the run id of the agent's session
- `prev_body_hash` / `new_body_hash` are sha256 hex; `chars_added` / `chars_removed` approximate the diff via longest-common-prefix (metric-only for the sparkline, not a structural diff)
- **A06 â€” `boundary_flags` JSONB** array of `'item_id' | 'agent_id' | 'project_id' | 'run_id'` slugs detected in the new body. Empty when clean. Migration `023_memory_boundary_flags.ts`.

### ICommitVerification (Theme 11)

**Why this entity exists**: One commit per chore is a discipline rule the agent must self-enforce, but a rule with no audit is a suggestion. After every issue-attached agent run, the verifier in `services/commit-verifier.ts` shells out to `git log --since <run.started_at>` in the project's cwd, parses every commit subject against the Conventional-Commit pattern, and persists the classification (`compliant` | `partial` | `silent` | `clean`). The Agent Detail Overview tab renders the last 10 as colored dots â€” the Owner sees at a glance whether the agent is following discipline.

Fields: `id, run_id, item_id, agent_id, result, commit_count, problems, checked_at`

- `result` âˆˆ `compliant | partial | silent | clean` (CHECK constraint). Verifier classification:
    - **`clean`** â€” no commits made AND no dirty modifications (legitimate read-only run, or non-git cwd).
    - **`silent`** â€” files modified during the run but never committed (the worst result; flagged with a system comment on the item).
    - **`partial`** â€” at least one commit but some commit had problems (missing `Refs:` line, non-Conventional subject, unknown type, summary > 60 chars).
    - **`compliant`** â€” every commit in the window parsed cleanly with a valid `Refs:` line.
- `commit_count` â€” total commits found in the window.
- `problems` JSONB â€” array of `{ commit_sha?: string; reason: string }`. Reasons: `subject-not-conventional`, `unknown-type:<x>`, `summary-too-long`, `refs-missing`.
- `run_id` / `item_id` carry the audit forward without an FK so historical rows survive run/item purging.

Verifier emits SSE `commit_verification { agentId, runId, commitVerificationResult }` after every audit. Non-clean results also append a system comment to the item so the activity feed surfaces the audit.

Migration 013. Index: `idx_commit_verifications_agent_checked` on `(agent_id, checked_at DESC)` so the Overview tile fetches the agent's last 10 quickly.

### Theme 09 â€” autonomous-agent fleet columns

Two columns on `agents` for the autonomous fleet (and any future custom agents):

- **`kind_slug` TEXT NOT NULL DEFAULT 'custom'** â€” archetype tag. Fixed slugs for the 4 seeded agents (`ai-news` | `market-research` | `regulations` | `jira-to-epic`); `custom` for everything else. No CHECK constraint â€” Owner-created kinds can carry their own slugs.
- **`settings_json` JSONB NOT NULL DEFAULT '{}'** â€” per-archetype config. Schema depends on `kind_slug`; validated at the route boundary via the Zod schemas in `@atlas/shared/agents/settings-schemas.ts`. `custom` agents pass through (`.passthrough()`).

Migration 011. Index: `idx_agents_kind_slug` on `agents(kind_slug)`.

The autonomous catalog entries (`agent-ai-news`, `agent-market-research`, `agent-regulations`, `agent-jira-to-epic`, `agent-ai-readiness`, `agent-knowledge-base`) ship `status: 'inactive'`. They have no cadence of their own (scheduled runs are a commercial-edition feature): the Owner runs one on demand (Run now → `POST /api/run`), or assigns it to a Task. The prompt builder renders `{{ key }}` placeholders against `settings_json` so prompts can reference their config (`{{ topic }}`, `{{ competitors }}`, etc.); missing keys render as `(unset)`.

**Installable agents** come from `packages/api/src/marketplace/catalog/*/{manifest.json,prompt.md,checklists.json}` (synced into `marketplace_agents` by `runSeed`): 7 entries: `agent-solo` ("Solo Engineer", the general-purpose agent a Task is assigned to) plus the 6 autonomous agents above.

### IProject
**Why this entity exists**: Projects are the top-level work container â€” every issue tunnels through `project_id`. **ADR 0018:** a project is a *container*, not a repo — it holds 0..N repos, all equal, and the git fields it used to carry moved onto them (migration 045).

Fields: `id, name, issue_key_prefix, description, status, guardrails_md, team_managed, jira_status_map, created_at, updated_at, last_activity_at`

- `is_test_sandbox` (migration 002, DB only; unique partial index — at most one): the **Tests** project agent tests run in by default (`services/test-project.ts`). Created on first use with prefix `TST` (next free `TSX`/`TSY`/`TSZ`/`TXT` if the Owner already uses it) and one local sample repo `atlas-test-sample` under the workspace root — no remote, no credential, `verify_command` `npm test` — so nothing a test agent does can be pushed.

- `jira_status_map` (jsonb, migration 009) — `IJiraStatusMap` `{ draft?, ready, in_progress?, waiting_for_info?, in_review?, done? }`, each a list of Jira status names, matched case-insensitively.
  - `ready` is required. No name may appear in two groups (`JiraStatusMapSchema`).
  - NULL = Jira status ignored (pre-v2 behaviour).

- `guardrails_md` is free-form markdown (project guardrails are a separate table â€” see below)
- Env secrets, guardrails and the constitution stay project-level and are staged into every repo.
- A project with **no** repos is a normal state (its last repo was removed, or it was created before one was added): it can hold Tasks but cannot queue them.

### IProjectRepo (ADR 0017, migrations 043 + 045)
A git repo of a project. Fields: `id, project_id, name, git_url, git_path, credential_id, default_branch, clone_status, setup_sh_body, setup_ps1_body`. (`verify_command` was dropped by migration 006.)
- Every repo is an ordinary `project_repos` row; **there is no primary**. A repo that predates ADR 0018 carries its project's id, which is what kept its worktrees, git-lock key and Jira sources valid through migration 045.
- `name` is a slug unique within the project and is the repo's folder name in a multi-repo workspace. Each repo has its own credential, default branch, clone status, setup scripts and auto-fetch schedule.
- **Order matters**: `position, created_at`. The *first* repo of a Task holds Task-wide files, hosts the multi-repo workspace folder, and lends its bot identity to the agent (no token — ADR 0015: Atlas pushes).
- `clone_status` âˆˆ `pending | cloning | ready | error`
- There is no per-repo verification command (migration 006 dropped `project_repos.verify_command`); the agent runs the project's own checks inside its run.

### ITask (ADR 0015)
**Why this entity exists**: The Task is the unit the Owner schedules and verifies. One Task = one assigned agent = one run = one branch = one PR (one per changed repo): the agent does everything the Task needs, including any sub-tasks, and the Owner verifies the one result. It replaced the epic (migration 037).

Top-level item, scoped to a project. `items.type = 'task'`, no parent.

Fields (`ITask`): `id, project_id, title, description, status, assignee_agent_id, reporter_agent_id, priority, acceptance_criteria, spec_md, pr_url, labels, repo_ids, worktree_branch, worktree_path, is_test?, created_at, updated_at`. `ITaskListItem` adds `sub_task_count`.

- `repo_ids` (ADR 0017/0018, migrations 043 + 045): the project repos the Task works on, in order.
  - The first repo holds Task-wide files such as specs and QA CSVs.
  - A Task always names at least one repo: create fills in the only repo of a single-repo project and 400s when there are several to choose from. Queueing a Task whose repos were all removed 409s.
  - The list is validated against the project, and changing it returns 409 while a Task run (running or parked) holds the Task.
  - With several repos, the run works them side by side in one workspace and opens one PR per changed repo, all listed as `item_external_links`. `pr_url` is the first PR, and the Task closes when the **last** PR merges.

- `assignee_agent_id` — the agent that runs the Task. Setting it on a `draft` Task (create or `PATCH …/assign`) moves it to `ready`, which queues it. `items.workflow_id` is a DB-only leftover of the commercial edition; Atlas Open never sets it.
- `spec_md` — an optional spec for the whole Task; `pr_url` — the one PR its run opened (also an `item_external_links` row).
- `worktree_branch` — the run branch (`atlas/task/<taskId>` unless the Owner points it at a valid existing branch); `worktree_path` stays null for Task runs (the path lives on `workflow_runs`).
- `id` is `<project issue_key_prefix>-<seq>` (e.g. `SDB-12`), shared counter with sub-tasks.
- Closing (`→ done`) is refused with 422 while any sub-task isn't `done`, unless overridden (`assertChildrenDone`, `routes/tasks.ts`).
- `is_test` (migration 016; **on the wire** as optional `is_test` on `ITask`/`ISubTask` since migration 002): the item an agent test run materialised. **Visible everywhere** since migration 002; the web tags it "Test". See `items_live` below.

> **All items carry a nullable `reporter_agent_id`** referencing `agents.id`. Agent-created items stamp the creating agent (the `x-atlas-agent-id` header / MCP `agent_id`); UI-created items stamp `null`, rendered as Owner. Agent narrative flows through the comments thread (the `proposed_plan_md` trio was dropped by migration 021).

### ISubTask (ADR 0015)
**Why this entity exists**: A piece of its Task's work — e.g. one bug fix in a batch, written by the Owner or by the agent. Sub-tasks never run on their own: the Task's agent works them inside the Task's run, on the Task's branch.

`items.type = 'sub_task'`, `parent_id` = a Task (trigger `items_check_parent`).

Fields (`ISubTask`): `id, task_id, title, description, status, assignee_agent_id, reporter_agent_id, priority, acceptance_criteria, started_at, labels, created_at, updated_at`. No `workflow_id`, spec, PR or worktree fields on the wire (migration 037 cleared `workflow_id` on sub-tasks).

- Open = status neither `in_review` nor `done`. The Owner closes it after verifying the branch.
- `started_at` is stamped on the first `in_progress` transition through the API.

> **Removed by migration 037:** item kinds `epic`, `story`, `bug`, `sub_bug` (converted, see `api-surface.md` migrations), the bug-only columns (`steps_to_reproduce`, `expected`, `actual` — folded into the description as `### …` sections first — and `frequency`, `failure_scope`, `detected_at`, `occurrence_count`, `occurrence_total`), `items.created_by_workflow_run_id`, and the `item_type` enum (`type` / `parent_type` are text + CHECK). The `points` column still exists in the DB but is on neither interface.

### IComment
**Why this entity exists**: Discussion threads on issues are polymorphic by design â€” the same conversation table works for every issue type so the unified `IssueDetailShell` can render a comment thread without per-type branches. Distinct from IIssueEvent because comments are free-form human/agent prose, whereas events are structured state transitions. Both feed the merged activity stream so the Owner reads one timeline.

Threaded comments on any issue.

Fields: `id, issue_type, issue_id, author, body, created_at` — `issue_type` ∈ `task | sub_task` and `author` ∈ `'owner' | 'agent'` (`agent` rows include `agent_id`).

**Agent attribution is resolved at write time, not read time.** There is no denormalized author name: the UI looks `agent_id` up in the agents list (`ActivityCard.tsx`) and falls back to the literal string `"Agent"` when it is null. Three writers reach `commentsService.create` - `POST /api/comments`, `POST /api/issues/:type/:id/reply`, and the MCP `update_item({action:'add_comment'})` - and only the middle one enforces `agent_id` (`ReplyToItemSchema` refines it; `CreateCommentSchema` defaults it to null). The MCP path has no bound identity at all: `plugins/mcp-host.ts` serves one in-process MCP on a shared loopback port for every agent, so the only identity is the optional, self-declared `agent_id` tool argument, which the model often omitted.

Since 2026-09-12 `create()` resolves a missing `agent_id` from the item's live run (`agent_runs` where `status IN ('queued','in_progress')`), which migration `003_active_run_invariant.ts` constrains to at most one row per item via a partial UNIQUE index. `create()` mirrors the resolved id into the `comment_added` event's `actor_agent_id`, so the same fix stops the activity feed attributing agent actions to the Owner. Rows written before the fix are repaired by migration `031_backfill_agent_comment_attribution.ts`; a comment with no run covering its timestamp stays null and still renders as `"Agent"` - deliberately, since guessing would put a wrong name in an audit trail.

`comments_agent_id_fkey` is `ON DELETE SET NULL`, so deleting an agent still erases its name from every comment it ever wrote. A denormalized `author_name` column is the only durable answer (`counts.ts` already denormalizes `a.name as agent_name` for the dashboard); not shipped - it needs a migration + backfill of its own.

**Owner reply resumes a parked run.** When the Owner comments on a Task whose run is `waiting_for_owner`, `create()` claims the run inside the comment's transaction (run → `running`, item → `in_progress`, `status_changed` event with `detail='resumed_by_owner_reply'`), broadcasts `counts_changed` after commit, and calls `workflow-engine.continueResumedRun` in the background: a run parked on a failed delivery retries it; otherwise the agent re-runs and reads the reply in the thread. Agent comments never trigger it; an item without a parked run is left alone.

### IItemExternalLink
Off-platform URL attached to an item: `link_kind='pull_request'`, or `'jira_issue'` (migration 042; written only by the Jira bridge, with `external_ref` = the Jira key and `title` = its summary). Table `item_external_links` (migration 020), UNIQUE `(item_id, url)`, cascades on item delete. `EXTERNAL_LINK_KINDS` (what the UI and MCP may add by hand) stays `['pull_request']`.

Fields: `id, item_id, link_kind, url, title, external_ref, created_at, created_by_run_id, pr_state, ci_state, ci_failing_checks`.

- `pr_state` ∈ `'open' | 'merged' | 'closed' | null` (migration 033, CHECK constraint) — last GitHub state observed for a PR link; null until the first successful lookup, and forever on a project with no credential.
- `pr_state_checked_at` (DB only, not on the wire) — stamped on every lookup attempt, success or failure. Reading the links (`GET …/external-links`, every `/full` envelope) refreshes PR links older than 5 min in the background; `POST /api/issues/:type/:id/external-links/refresh` refreshes synchronously.
- `ci_state` ∈ `'pending' | 'success' | 'failure' | null` (migration 023, CHECK) — CI on an **open** PR's head commit (check runs + legacy statuses, see `ci-routing.ts`). Null = no CI observed (a repo without checks, or never read), not success. `ci_failing_checks` = `ci_summary` jsonb `[{name, detail}]`, `[]` unless failing.
- DB only: `ci_head_sha`, `ci_checked_at`, `ci_handled_sha`. `ci_handled_sha` belongs to the commercial edition's CI follow-through (automatic fix runs on red CI) and is never written in Atlas Open; here CI state only colours the PR chip.

### team_managed — schema only
Team config sync is a commercial-edition feature. Atlas Open keeps `team_managed` on `projects` / `agents` / `workflows` (and `IProject.team_managed` stays on the wire, always `false`); no route or service writes it. The `team_config` table was dropped in the 2026-10-23 squash (ADR 0032).

### IJiraConfig / jira_sources / jira_issues (ADR 0016, migrations 042 + 044 + 010)
`jira_config` is a singleton row holding the Jira bridge config. `IJiraConfig` returns every column except the token, and adds `api_token_set: boolean`:
- `enabled`, `site_url`, `email`
- `poll_interval_minutes`
- `extra_fields` (string[])
- `last_sync_at`, `last_sync_ok`, `last_sync_message`

`sources` is **no longer on this row** (migration 010): the combos belong to a project.
The singleton keeps only what is genuinely one-per-install — the connection and the poller.

`jira_sources` — one row per **query + agent + repos** combo:
- `id serial PRIMARY KEY`. The id IS the routing order, **globally, across every project**.
- `project_id` → `projects`, `ON DELETE CASCADE`.
- `jql`, `agent_id` → `agents` `ON DELETE SET NULL` (migration 020): the agent imported Tasks are **assigned to**, which queues them when their Jira status maps to Ready. Null leaves imported Tasks as drafts with a `needs_you` notification ("assign an agent to it"). The old `workflow_id` column remains, unused.
- `repo_ids jsonb`, ordered, the same shape as `items.repo_ids`; `projectRepos.remove()` strips a deleted repo from both.

**Routing.** Every sync runs every source's JQL. An issue matching several sources still
becomes **one** Task — `jira_issues.jira_key` is the PK — in the project of the
**lowest-id** (first-created) source, with `repo_ids` = the repos of that project's
matching sources in source order. The assigned agent is that matched source's **own** `agent_id`.
Because new rows
always sort last, adding a source to a second project can never hijack routing an existing
source already owns.

`jira_issues` is DB-only, one row per imported Jira issue:
- `jira_key` is the PK.
- `item_id` → the Task. It is SET NULL when the Task is deleted, and such a key is never re-imported.
- `raw`: the last full issue JSON.
- `seen_comment_ids`: Jira comments already reflected in Atlas.
- `posted_comment_ids`: comments the bridge posted to Jira.
- `imported_comment_ids`: Atlas comments that came from Jira.
- `pushed_comment_id`: the digest watermark over `comments.id`.
- `pushed_status`: the last status announced to Jira.
- `done_synced_at`: set once the final comment is posted. A linked Task that leaves `done` while this is set is a **reopen**: the push posts "reopened, …", clears it and transitions Jira again.
- `synced_title` / `synced_description` (migration 008): what the bridge last wrote, so an Atlas edit is kept. Only the part above the managed sections counts.

`jira_attachments` (migration 009), one row per Jira attachment Atlas has seen:
- `id` (Jira attachment id) PK, `jira_key`, `item_id`, `filename`, `mime_type`, `size`.
- `path`: the local copy under `<dataDir>/jira-attachments/`. It is NULL when not copied, and `skipped_reason` says why (`over 25 MB`).
- A failed download writes no row, so the next sync retries it. A file removed in Jira drops its row. Settings → Reset deletes the rows and the folder.

### IIssueEvent (audit log)
**Why this entity exists**: Status and assignment changes need an audit trail the UI can render alongside comments â€” otherwise the Owner sees "this is in_dev" but can't tell who moved it there or when. Structured fields (event_type, field, from_value, to_value) make events queryable and machine-renderable in a way that free-text comments can't be. Kept distinct from IComment so the activity feed can render status pills differently from quoted text.

Persistent audit record for any non-comment activity on an issue. Backed by the `issue_events` table (defined in the consolidated baseline `001_initial.sql`). Comments stay in `comments`; the activity feed merges both streams ordered by `created_at`.

Fields: `id, issue_type, issue_id, event_type, actor_agent_id, field, from_value, to_value, detail, created_at`

- `event_type` âˆˆ `'created' | 'status_changed' | 'assigned' | 'field_updated' | 'comment_added' | 'link_created' | 'link_deleted' | 'deleted' | 'unblocked'`
- `field` ∈ `'status' | 'assignee' | 'title' | 'description' | 'reporter' | 'spec_md' | 'pr_url' | 'acceptance_criteria' | 'priority' | 'link' | 'external_link' | 'git_push' | 'repo_exec'` or `NULL` for `created` / `deleted`. `IssueEventField` still lists the retired `points` and bug-field names (`steps_to_reproduce`, `expected`, `actual`, `frequency`, `failure_scope`) for old rows; nothing writes them since ADR 0015 (`events-log.ts` `DATA_KEY_TO_FIELD`)
- `actor_agent_id` is `NULL` when the Owner (or the API) was the actor
- `link_created` / `link_deleted` events are emitted on BOTH endpoints of the link (so each item's activity tab shows the change). `to_value` holds the other item's id; `detail` encodes direction + relation_type like `depends_on â†’ ATL-3` (outgoing) or `depends_on â† ATL-2` (incoming).
- `deleted` is emitted by each entity service's `delete()` immediately before the underlying item row is removed. The event row survives the cascade because `issue_events.item_id` has no FK; the deleted item's history stays queryable.

Status events are also the source of Analytics' Tasks shipped and median cycle time (`services/analytics.ts`, response type `IAnalytics`): an item's first Done and first In progress.

Read via `GET /api/issues/:type/:id/activity`, which returns a merged `IActivityItem[]` (each item is either `{ kind: 'comment', data: IComment }` or `{ kind: 'event', data: IIssueEvent }`).

### IGuardrailRule (global)
**Why this entity exists**: Agents need a binding constitution that travels with every prompt â€” "do not delete the main branch", "ask before touching secrets". Modeling rules as structured rows (category + severity) lets the prompt-builder render them deterministically and lets the UI group them by risk surface. Distinct from IProjectGuardrail because workspace rules apply to every agent on every project; project rules layer narrower constraints on top.

A workspace-wide safety rule.

Fields: `id, category, body, detail, severity, enabled, sort_order, created_at, updated_at`

- `category` âˆˆ `file_system | secrets_credentials | git_branches | side_effects_network | escalation_scope`
- `severity` âˆˆ `block | ask_owner | warn`

### IProjectGuardrail (per-project)
**Why this entity exists**: Some constraints only apply to one repo (e.g., "don't run migrations against the staging DB in this project"); modeling them at the project level keeps the global guardrail set from bloating with repo-specific quirks. Lighter shape than IGuardrailRule (no severity enum, no category) because per-project rules are usually plain "do/don't" statements without the full risk taxonomy.

Lighter-weight per-project rules surfaced in the Project Guard-rails tab.

Fields: `id, project_id, title, body_md, icon, enabled, sort_order, created_at, updated_at`

### INotification
**Why this entity exists**: Out-of-band signal delivery (external notification pings, in-app alerts) needs its own queue so the Owner can retry transient failures and so quiet-hours batching has somewhere to defer rows to. Modeling it as a persisted queue (vs. fire-and-forget) preserves the audit trail and lets the Notifications page show what was attempted, when, and why it failed.

Delivery queue for external notification + in-app notifications.

Fields: `id, kind, issue_type, issue_id, project_id, message, event_type, agent_id, external_status, failure_reason, push_status, push_failure_reason, read_at, link_url, external_deferred_at, reminder_id, in_app, created_at`

- `kind` âˆˆ `needs_you | update | system`
- `external_status` âˆˆ `none | pending | sent | failed`. `pending` + non-null `external_deferred_at` = held by quiet hours until the window ends (migration 010).
- `link_url` — where a click opens; stamped at create time (`notificationLinkUrl` in @atlas/shared).
- `in_app` (migration 013, default true) — false for a log-only row: an external-only reminder fire or an MCP `send-external` (`event_type='mcp_external'`). It shows in the Notification Log and the reminder fire log, never in the In-App Feed, the unread count or Mark All Read, and gets no web push.
- `external_status='none'` with a `failure_reason` = **skipped**: held through quiet hours, but its event toggle was off when the window ended ("Skipped: event turned off while held").
- DB-only columns (not on `INotification`, migration 013): `external_event_key` (the key a hold was raised under, re-checked at the flush), `external_claimed_at` / `external_reclaimed` (in-flight claim; a claim older than 10 minutes is retried once, then the row is failed).
- `reminder_id` — the reminder whose fire produced the row (FK `ON DELETE SET NULL`, migration 011); null for every other producer and for fires before the log. It is the reminder fire log and lets the feed snooze from the card.
- `event_type` âˆˆ external notification event keys (see below)

### IAgentRun
**Why this entity exists**: Every agent invocation produces an auditable run row — without it, the Owner can't tell why an item transitioned (which agent, what version of the prompt, when it succeeded/failed). The dashboard "in motion" panel, and per-agent Runs tab all consume the same row shape. Cancellation as an explicit terminal state (vs. delete) preserves history for runs that were intentionally aborted.

A spawned subprocess invocation.

Fields: `id, agent_id, issue_type, issue_id, project_id, status, started_at, ended_at, error, output_summary, created_at`

**Two lifecycle shapes:**
- **Task-run step** (dominant) — `item_id` + `workflow_run_id` + `node_id` set. Spawned by the Task runner in the run's worktree.
- **Ad-hoc** — `workflow_run_id` and `item_id` null, `project_id` optional. `POST /api/run` from the Run-now dialog — how the on-demand catalog agents run; it runs in a temp dir and never routes. Rows with `item_id` set and no `workflow_run_id` are older history; rows with `workflow_run_id` set and no item come from project-level workflow runs of an upgraded install.

`project_id` has no FK so historical rows survive `DELETE FROM projects`. A partial index (`idx_agent_runs_project_id WHERE project_id IS NOT NULL`) keeps lookups cheap when most rows are item-attached.

- `status` ∈ `queued | in_progress | completed | error | cancelled | setup_failed` — matches `RunStatus` in `@atlas/shared` and the `agent_runs_status_check` CHECK. (The doc previously named `running` and `failed`, which have never existed, and omitted `in_progress`, `error` and `setup_failed`, which do.)
- **The live set is `queued` + `in_progress`**, which is what the partial unique index `agent_runs_one_live_per_item` (migration `003`) constrains to one row per `item_id`. `setup_failed` sits deliberately outside it so a retry isn't blocked (see migration `005`'s header).
- **Promotion is guarded, not unconditional.** `spawnAgentRun` flips `queued → in_progress` from a 200ms `setTimeout`, and by the time that timer fires the row may have left the live set (Owner cancelled, `failOrphanedRuns` swept it, the item was deleted) with a replacement run already holding the slot. So the UPDATE carries `WHERE status = 'queued'` and checks `numUpdatedRows`: zero rows means the run is no longer ours to start, and the runner returns instead of spawning. Without the predicate the stale row re-entered the live set behind the replacement's back and raised 23505 as an unhandled rejection — the run silently never started and the reason lived only in the API log. Its regression test (`agent-dispatcher.integration.test.ts`) was deleted with the dispatcher; nothing asserts this against the real index today.

**Two-persona columns:** `persona`, `review_outcome` and `review_reason` were removed with the in-agent reviewer persona; only `parent_run_id` (self-FK, ON DELETE CASCADE) remains. The Task runner writes it on a crashed step's one automatic retry (the retry's `parent_run_id` = the errored step), which is how `onStepFinished` knows the retry was spent.

**Run + config snapshot columns (migration 035):** `workflow_run_id` (FK → `workflow_runs`, ON DELETE SET NULL) and `node_id` tie a run to its Task run. `cli`, `model`, `effort`, `prompt_version` record the agent config the run spawned with. `spawnAgentRun` writes them on both write paths. `IAgentRun` exposes `workflow_run_id` + `node_id` (`GET /api/run/:id`, `GET /api/run`, `GET /api/agents/:id/runs`); `cli` / `model` / `effort` reach the web through `IWorkflowRunStep`; `prompt_version` is DB-only.

**Outcome columns** (`outcome_kind`, `outcome_summary`, `outcome_reason`, `outcome_checklist`) are persisted by `completeRun` for every run shape; the engine routes on them.

**`trace_summary` (migration 017)** — what the run actually *did*, as opposed to what it reported about itself. `output_text` has held the full stream-json of every dispatch since the runner shipped and nothing server-side ever read it, so the only thing anyone could assert about a run was its own `atlas-outcome` block. `run-trace-parser.ts` reads that transcript **once, in `completeRun`**, into this jsonb column: `{ source, turns, tool_calls, tools{}, tool_sequence[], thinking_blocks, subagent_turns, files_touched[], errors, ttft_ms, truncated }`.

- Parsed at completion rather than on read: `output_text` runs to megabytes and the Tests tab polls every five seconds. Not its own table either — nothing queries an individual tool call, and every consumer wants the whole summary for one run.
- **Every field a CLI cannot report is `null`, never `0`.** Copilot emits `tool.execution_start` so names, counts, order and turns all survive, but it has no thinking event and does not surface tool arguments — so `thinking_blocks` and `files_touched` are null on a Copilot run. "We did not look" and "it did not happen" are different answers, and an expectation asserting on a field this CLI cannot answer must come back `errored` rather than silently passing.
- `files_touched` is relative to the run's own `cwd`, taken from the transcript's `system/init` event. Raw, the paths are absolute against a temp sandbox that changes every run — unmatchable by any expectation, and a leak of the machine's temp layout into product data.
- `ttft_ms` is measured from `agent_runs.started_at`, because `system/init` carries no timestamp of its own.
- **`NULL` on every run that finished before the migration** — there is deliberately no backfill, since reparsing every historical transcript is minutes of blocking multi-megabyte I/O to answer questions nobody is asking. Consumers render that as "—", never as zero.
- On the wire as `IRunTraceSummary` from `GET /api/run/:id` and `GET /api/agents/:id/runs`. **Deliberately `NULL::jsonb` in list mode** (`GET /api/run`): a trace carries up to 200 tool names and 100 paths, which over 500 rows is megabytes no list renders. Selected as an explicit NULL rather than omitted, because a column that `asAgentRun` maps but the query never SELECTs is a bug this route has already shipped twice.

### ICliSession (Terminal v1+v2)
**Why this entity exists**: The Terminal page hosts long-lived, interactive CLI sessions (Claude Code, GitHub Copilot CLI, or Claude Code-on-Ollama) inside Atlas so the Owner can drive a scoped worktree from the same UI as the rest of the app. Sessions are first-class rows — not ephemeral process handles — because we need cross-restart resume (`claude --resume <sid>` / `copilot --resume <sid>`), idle-notification deep links, per-(project, branch) uniqueness, and an audit trail of which branch went where. The PTY itself lives in-memory in `services/cli-session-host.ts`; the row carries everything else.

Fields: `id, project_id, title, status, cli, worktree_path, worktree_branch, credential_id, claude_session_id, model, initial_prompt, created_at, updated_at, last_active_at, closed_at, finalize_pr_url, item_id, transcript_jsonl, transcript_ingested_at`

**Two kinds share this table** (migration 030). `project_id IS NULL` marks a **standalone** session — a PTY the Owner opened directly on a folder of their choosing, with no project, no worktree and no `.atlas/` staging. It is the sole discriminator; `routes/cli-sessions.ts` gates every branch on `isStandalone()`. See [`26-terminal-standalone`](pages/26-terminal-standalone.md).

- `worktree_path` means **the session's cwd**, not "a worktree". For a project session that is the Atlas-provisioned worktree; for a standalone session it is the Owner's folder. Storing the folder here is deliberate: `cli-transcript-ingest` resolves `~/.claude/projects/<encodeClaudeProjectDir(worktree_path)>/<claude_session_id>.jsonl` from it, so spend tracking, the transcript column and the history page all work for standalone sessions with no extra code.
- `worktree_branch IS NOT NULL` is what means **Atlas created and owns that directory**. The finalize path must key its teardown off this, never off `worktree_path` — `cleanupWorktreeAfterPush` deletes the directory it is handed, and for a standalone session that is a real repository.
- `credential_id` (migration 030, FK → `credentials`, ON DELETE SET NULL) is the Owner's explicit per-session pick. Project sessions leave it null and resolve `projects.credential_id`; resume and finalize both read `session.credential_id ?? project.credential_id` so an explicit pick is never silently replaced by a project default.

- `cli` ∈ `claude | copilot | ollama`. Migration 017 added the column; 029 widened it for `ollama`. Existing rows default to `claude`. All three accept `--session-id <uuid>` on start and `--resume <uuid>` on rejoin, so Pause/Resume work identically — trivially so for `ollama`, which spawns the same `claude` binary.
- `status` ∈ `active | paused | closed | errored`. Lifecycle: active → paused (manual Pause OR PTY exit) → active (Resume) → closed (Stop pushes + tears down worktree). `errored` is terminal-on-spawn-failure.
- `claude_session_id` — Atlas-minted UUID we pass via `--session-id`. Column name predates copilot support; semantically it's "the session id the CLI knows this run by" for either CLI.
- `worktree_branch` participates in a unique partial index `cli_sessions_one_active_per_project_branch` covering `(project_id, worktree_branch) WHERE status IN ('active','paused') AND worktree_branch IS NOT NULL` — same invariant as `agent_runs_one_live_per_item` so worktree-authoring paths can't collide. The `IS NOT NULL` clause is why standalone rows need no index change: they carry a null branch and so can never collide with each other or with a worktree, and multiple standalone sessions on one folder are allowed.
- `item_id` is the optional Atlas item anchor. When set, the create flow stages `.atlas/current-task.md` (orchestrator-style item snapshot) into the worktree. The user's optional `initial_prompt` is appended to the same file as a `## User's initial prompt` section. The PTY auto-types a single pointer line (`Read \`.atlas/current-task.md\` for the full task context, then begin.`) so the CLI picks it up on its first turn.
- All worktree staging (constitution, templates, `.claude/commands/atlas-*.md`, `.github/prompts/atlas-*.prompt.md`, current-task.md) is owned by the shared `stageCliWorktree` helper at `services/worktree-stage.ts`, which is also the call site used by `agent-runner.spawnAgentRun`. The terminal route skips the helper's `includeOutcome` and `activeRunCopilotAgent` flags — those are agent-run-only.
- Idle-notification stream: when a session has no PTY output AND no user keystrokes for `settings.terminal_idle_notify_seconds` (default 300), the host fires a `terminal.waiting_for_input` notification with `link_url: /terminal/<id>`. The host fires once per idle stretch; refreshing the page does NOT re-arm it because the attach replay is a serialized screen snapshot (per-session `@xterm/headless` mirror in `services/terminal-screen-state.ts`) that contains no DSR queries for xterm.js to auto-answer — every inbound byte after attach really is a user keystroke. The snapshot design also means reconnects never render mid-escape-sequence "zombie" characters the way the old byte-ring backlog replay did.
- `transcript_jsonl` / `transcript_ingested_at` (migration 018) — populated when a session reaches `closed`/`errored`. Service `cli-transcript-ingest.ts` reads the CLI's own on-disk JSONL (`~/.claude/projects/<encoded-cwd>/<sid>.jsonl` or `~/.copilot/session-state/<id>/events.jsonl`) and writes it into the column. `GET /api/cli/sessions/:id/transcript` returns these for terminal-state rows (409 for active/paused) and lazy-ingests when the column is still NULL. Active/paused sessions never carry transcript content because history is only meaningful for finished sessions.

### ICredential
**Why this entity exists**: Cloning private repos needs tokens; storing them on the project row would leak secrets into list queries and force re-entry per project. Modeling credentials as a separate, encrypted-at-rest entity lets one credential serve many projects and lets the GET list response omit the plaintext (only fingerprint + metadata leaves the server). The fingerprint is the human-checkable identifier so the Owner can disambiguate without exposing the secret.

Encrypted git credential.

Fields: `id, label, host, kind, token_fingerprint, scope, expires_at, last_used_at, created_at, updated_at`

- `kind` âˆˆ `pat | ssh | app_password` â€” only `pat` is implemented today
- Token stored encrypted (AES-256-GCM). `token_fingerprint` is the SHA-256 hash of the plaintext, exposed in the UI for identification.
- `human_name` / `human_email` (migration 026) are valid on **both** kinds and mean different things by kind. On `github_app` the human is a **co-author**: the bot is the primary author (`[user]` = `<app_slug>[bot]`) and the human is credited via a `Co-Authored-By` trailer written by the `prepare-commit-msg` hook. On `pat` the human is the **author** — a PAT has no identity of its own, so `buildGitAuth` writes these straight into the session's `[user]` block. Both must be set for that block to appear; with neither (or only one) commits fall back to the host machine's `~/.gitconfig`, which is the pre-existing behaviour.
- `human_gh_login` stays `github_app`-only — it feeds `gh pr create --assignee` and the `Requested-By: @<login>` PR-body prefix, neither of which any PAT flow reaches. The service rejects it on a PAT patch.

### ISettings
**Why this entity exists**: Workspace-level config (owner profile, External Notification Channel, env, notification routing, onboarding state) lives in one row because there's only one Owner and one workspace. Modeled as a row rather than scattered key/value pairs so PATCHing multiple fields (e.g., accent + workspace) stays atomic and readable. `onboarding_complete` lives here because the route guard reads it on every request.

Single-row settings table.

Fields: `owner_name, accent_color, workspace_path, onboarding_complete, external_notification_token (encrypted), external_notification_chat_id, external_notification_endpoint_label, external_notification_last_test_ok, external_notification_event_toggles (JSON), quiet_hours_from, quiet_hours_to, quiet_hours_timezone, constitution_md, ...`

### ICliModel
**Why this entity exists**: CLIs ship new model names faster than the app releases; modeling the registry as user-editable data means the Owner can add tomorrow's model without a code change. Pre-validating model names through the registry also prevents the agent picker from offering values that would spawn a failing CLI invocation.

Per-CLI model registry; controls what shows up in the Add Agent dialog and per-agent model dropdowns.

Fields: `id, cli, model_name, note, created_at`

### Task run record (`workflow_runs`, migration 020)
**Why this entity exists**: One execution of a Task by its assigned agent. The run owns the Task's worktree and branch for its whole life — across a park, an Owner reply and a resume — and holds the Task while no agent step is live. The table is named `workflow_runs` for historical reasons: every row in Atlas Open belongs to the built-in `solo` workflow (`SOLO_WORKFLOW_ID` in `services/workflow-engine.ts`), and its `graph_snapshot` is always `soloGraph(agentId)` = start → agent → end.

Fields (`IWorkflowRunSummary` / `IWorkflowRunDetail`): `id, workflow_id ('solo'), item_id, item_title, project_id, status, graph_snapshot, current_node_id, parked_node_id, park_reason, branch, worktree_path, setup_done, pr_url, pr_urls, started_at, updated_at, finished_at`; the detail adds `steps` (`IWorkflowRunStep[]`) and `total_cost_usd`.

- `status` ∈ `running | waiting_for_owner | completed | cancelled | error`. `running` → `waiting_for_owner` (park) → `running` (Owner reply or resume) → `completed` (delivered) / `cancelled` (stop). The engine never writes `error`; a failed step parks instead.
- `branch` = the Task's valid `worktree_branch` ?? `atlas/task/<taskId>`. `worktree_path` lives only here, never on `items.worktree_path`, so the orphan reaper can't push or delete it.
- `setup_done` flips after the first completed step so a re-run skips the project setup script.
- `pr_url` is the first PR, `pr_urls` every PR (one per changed repo of a multi-repo Task).
- `workflow_runs_one_live_per_item` allows one `running` or `waiting_for_owner` run per item. Only `running` locks item status / assignee writes (`workflow-lock.ts`); only `running` runs count against `MAX_PARALLEL_RUNS` (3).
- Each agent step is an ordinary `agent_runs` row with `workflow_run_id` + `node_id = 'agent'`; a crash's one automatic retry is a second row with `parent_run_id` = the crashed step.
- DB-only leftovers of the commercial edition: `parent_workflow_run_id`, `parent_node_id`, `loop_count`, `gate_rounds` and `repo_ids` (migration 019; read by `run-repos.ts` only for a run with no item). Atlas Open never writes the first four.
- `workflows` itself is only the FK anchor: the baseline seeds the `solo` row (`inactive`, `input_kind='none'`), and `startTaskRun` re-inserts it if missing. On an install upgraded from the commercial edition, older workflow rows remain `inactive` (and their runs remain as history); nothing in Atlas Open reads their settings, graph or schedule. `items.workflow_id` and `jira_sources.workflow_id` remain in the schema, unused.

### Run event (`workflow_run_events`, migration 024)
**Why this entity exists**: `workflow_runs.park_reason` holds only the current wait and every resume nulls it, so a finished run kept no trace of having stopped for the Owner. The fleet page's "Owner interventions per Task" and Delivery's Owner-response time need that history.

Table `workflow_run_events`: `id, workflow_run_id (FK → workflow_runs, ON DELETE CASCADE), item_id, kind, node_id, reason, park_kind, created_at`.

- `kind` ∈ `parked | resumed` (CHECK). `parked` is written by `park()` with its reason; `resumed` by `resumeWorkflowRun` and an Owner reply (`comments.ts`, after its transaction commits).
- `park_kind` (migration 014) — set on every `parked` row, null on every `resumed` one (CHECK). Values are `WORKFLOW_PARK_KINDS` (labels in `WORKFLOW_PARK_KIND_LABELS`, @atlas/shared). The Task runner writes `question` (the agent asked), `no_outcome` (no `atlas-outcome` block), `rejected` / `checklist_failed` (the agent rejected, or ended `done` with a required checklist row unticked), `step_error` (errored again after its one retry), `lost_step` (reconcile found a run whose step stopped reporting), `setup_failed` (setup script, or preparing / refreshing the worktree) and `delivery_failed` (push or PR failed). The other values in the list are written only by the commercial edition's workflow features (or by the migration's backfill) and appear here only on upgraded history.
- `item_id` / `node_id` are copied from the run at the moment of the event. `item_id` is deliberately not an FK so the row outlives a deleted item.
- Writes are **best-effort** (`services/workflow-run-events.ts`): a failed history write never breaks a run.

### `run_gate_results` (migration 011) — schema only
Written by the commercial edition's script steps. Atlas Open never writes a row; `agent-scorecard.ts` still reads the table for `gate_catch`, which is therefore 0 on a fresh install.

### `items_live` (migration 016, filter dropped by 002)

**2026-09-28 — reversed (migration 002, ADR 0023 amendment).** The view no longer filters: test items appear in every list, count, search and aggregate, tagged "Test" in the web (`TestItemTag`). The Owner's reason: "the test created EXI-2 and I can't see it" is a bug, and test noise belongs in its own project rather than hidden inside a real one — so tests now default to the **Tests sandbox project** (`projects.is_test_sandbox`). The view keeps its name so its readers did not change; `is_test` still scopes the delete cleanup and keeps test PRs out of fleet delivery stats. The history below is why it was hidden.

**Why this view exists**: `agentTestsService.run()` materialises the item its agent acts on through the normal item services, on purpose — an agent that behaved differently against a synthetic item would make the test worthless (migration 014). The cost is that the item is real in every other way too: it takes an `ATL-nnn` key from the project counter and appears in Tasks, search, the queue, counts, label facets and analytics. A `sub_task` template creates two of them, because the sub-task needs a throwaway parent. The only marker used to be a `[test]` suffix in the title, which nothing read.

`CREATE VIEW items_live AS SELECT * FROM items WHERE NOT is_test`, plus a partial index `items (project_id, type) WHERE NOT is_test`.

- **Every list, count, search and aggregate reads `items_live`.** By-id reads keep using `items` — the run, the prompt builder, the Task runner and the comment thread all need the item they are working on, and a test whose own item vanished from under it would be a worse bug than the one this fixes. So do run-joins (`agent_runs → items` for a title): a test run is a real run of that agent.
- A view rather than a predicate on thirty queries, because the edit count is the same either way and what differs is the next listing somebody writes. One that forgets `.where('is_test','=',false)` looks exactly like one that remembers; one that reads `items` where its siblings read `items_live` is visible in a diff.
- **`SELECT *` freezes the column list at creation.** A migration that adds a column to `items` must recreate the view. `db/items-live-view.test.ts` compares the two column lists so that failure is a red test rather than a runtime error in production.
- Deleting a test deletes the items its runs made (`agentTestsService.remove`): `agent_test_runs.item_id` is `ON DELETE SET NULL`, so the cascade would otherwise leave them behind with nothing pointing at them.
- **Ceiling**: a test item still consumes the project issue counter, so the `ATL-nnn` sequence has gaps. Cosmetic once the rows are invisible; a separate namespace would mean a second allocation path against `items.id` as an FK target in a dozen tables.

### Starter tests (ADR 0023 phase 4, no migration)

**Why there was no table, and why there is now (migration 021).** `agent_tests.project_id` was NOT NULL, a catalog bundle has no project, and `marketplaceService.install` never sees one — so a shipped fixture could only be a template the Owner adopted by hand. The consequence was the thing the Owner actually saw: 8 of 24 agents shipped a fixture, nobody had clicked Add, and every agent page read "No tests yet", which is indistinguishable from no testing at all.

`project_id` is now nullable. A fixture belongs to the agent at rest and binds to a project when it runs — body first, then the fixture's own pin, then a 400. Never a default: a run materialises a REAL item that takes an `ATL-nnn` from the project counter, so choosing where to spend that is the Owner's. `source_test_id` + `source_hash` make adoption idempotent and edit-preserving (see `agent-starter-tests.ts`).

So an agent's tests ship as `catalog/agent-*/tests.json`, read from disk by `loadCatalog()` and adopted through the ordinary create form. `tests.json` is in `catalog-lock.ts`'s `BUNDLE_FILES` and in the loader's `hashEntry` projection — **both, or the loader's `content_hash` and the lock's `bundleHash` disagree about what a bundle is** — so editing a shipped test without bumping its version fails the lock test.

- `bundleHash` now **skips a file that is absent** rather than feeding an empty body into the digest. The old behaviour meant adding any new optional file to `BUNDLE_FILES` changed the hash of every bundle that did not have one: 24 version bumps to ship a file 8 bundles carry. All four original files exist in every bundle, so their hashes are unchanged by this.
- Adoption writes an ordinary `agent_tests` row. It is then the Owner's, and a bundle upgrade never touches it — which is why "what happens to a customer's edited copy on upgrade" is not a question this design has to answer.
- Contract-tested per bundle (unique ids, ≥1 expectation, a `max_cost_usd` ceiling, notes that say what it catches) and fleet-wide: **at least one shipped test must make `asked_question` the pass.** A starter set that can only express success cannot say that an agent which asked rather than inventing a feature has succeeded, which is the most valuable thing these tests check.

### IAgentTest / IAgentTestRun (ADR 0023 phase 1, migration 014)
**Why these entities exist**: Atlas ships a fleet of agents and lets customers install more, edit them and write their own, and had no way for anyone to find out whether one works. The measurement that existed was `evals/` — fixtures in the repo, a CLI runner, a CLI scorer, a gitignored markdown file — all of it local and none of it reachable by a customer.

**Why a test owns an item template rather than a prompt.** The `Test Run` tab (deleted) fired an ad-hoc prompt at an agent and was never usable as a test, for a structural reason: an agent that works a Task needs a Task — with a repo, acceptance criteria and a thread — and a bare prompt cannot exercise that. A test therefore carries the item it wants the agent to act on — which is exactly what a golden fixture already is, and why these are one primitive rather than two features.

Each shipped fixture carries a `kind` — `job` (it does its work, judged), `contract` (it asks or refuses when the input is not what it needs), `trace` (it stayed in its lane). Three per agent, one of each, enforced by `catalog-contract.test.ts`; before that every shipped fixture was a `contract` case and nothing asserted that an agent does its job.

Table `agent_tests`: `id, agent_id (FK → agents, CASCADE, **nullable** since migration 019), workflow_id (FK → workflows, CASCADE, nullable; never set in Atlas Open), suite, project_id (FK → projects, CASCADE, **nullable** since migration 021), source_test_id, source_hash (migration 021), repo_id (FK → project_repos, SET NULL — nullable: an agent that touches no repo still deserves a test), name, item_template jsonb, expectations jsonb, created_at, updated_at`.

**One primitive, two ways to run it (migration 019, ADR 0023 phase 3, ATL-173).** `CHECK ((agent_id IS NOT NULL) <> (workflow_id IS NOT NULL))`: run a fixture through one agent and it qualifies that agent.
- Atlas Open has no route that creates or runs a workflow-targeted fixture (that is the commercial edition's end-to-end eval), so every fixture here targets an agent; `agentTestsService.listForWorkflow` survives only as a read helper.
- `suite` is a **tag, not an entity**. Running a set is running its fixtures; comparing two fleet versions is reading the same suite filtered by the `label` each run carried.

- `item_template` = `{ issue_type, title, description?, acceptance_criteria?, labels? }`.
- `expectations` has two halves. **What it said**: `outcome_kind`, `required_checklist_all_passed`, `summary_contains`, `summary_omits`, `max_cost_usd`, `max_duration_s` — judged by the pure `evaluateAgentTest` (`services/agent-tests-evaluate.ts`), which replays `decideRunRouting`, the same function the Task runner routes on, so a test and the engine can never disagree. **What it did** (migration 017): `tools_required`, `tools_forbidden`, `max_turns`, `max_tool_calls`, `files_touched`, `files_untouched` — read from the run's own transcript rather than from the block the agent wrote about itself. `tools_forbidden: ["Edit","Write"]` on a reviewer is the canonical one: a reviewer that edited the code under review was not reviewing it.
- **Scope checks** (ADR 0023 amendment) — for an agent whose job is narrow ("never writes code, never answers who the president is"), asserted on what it actually said, ran and changed: `reply_must_match` / `reply_must_not_match` (case-insensitive regexes on the final reply — the stream's `result` event, else the last top-level assistant text; `extractRunTranscript`), `commands_forbidden` (regexes on every `Bash` command it ran; null for Copilot → `errored`), `no_code_changes` and `files_changed_only` (path prefixes; both from the checkout's real diff, migration 003), and `script: {body_sh}` — the Owner's bash, run by `agent-test-script.ts` in a temp folder holding `reply.txt`, `commands.txt`, `tool_calls.json`, `files_changed.txt`, `diff.patch`, `outcome.json` (60s; exit 0 passes; output becomes a `script:`-prefixed failure; a script that could not run is `errored`). Patterns are validated at the route (400). The judge now also sees the final reply (≤8k) and the commands.
- **An expectation that cannot be answered is `errored`, never a pass.** A trace expectation on a run from before migration 017, or a `files_touched` assertion against Copilot (which reports tool names but not their arguments), returns `errored` with the reason. Silently passing an assertion nobody could make would report evidence nobody had. A truncated file list can still prove a file WAS touched, but never that one was not — the entries it dropped are precisely the ones in question — so `files_untouched` against a truncated trace also errors.
- `asked_question` is a first-class **passing** expectation, not a fallback: an agent that asks rather than inventing a feature from an unanswerable Task has succeeded.
- `required_checklist_all_passed` **fails** when the agent has no required checklist rows, rather than passing vacuously — campaign finding F-012.

Table `agent_test_runs`: `id, agent_test_id (FK, CASCADE), agent_run_id (FK → agent_runs, SET NULL), item_id (FK → items, SET NULL), verdict, failures jsonb, cost_usd numeric(12,6), duration_s, created_at, evaluated_at`.

- `worktree_path`, `evidence jsonb` (migration 003, DB only): an agent-only test runs in a **detached checkout** of its Task's first repo (`agent-test-workspace.ts`) — at `origin/<default>` when that ref exists, else the local branch; no branch, no fetch, no push. `worktree_path` is set while the run is live; when it finishes, `collectEvidence` claims it atomically, stores `evidence = {base_sha, files_changed, diff (≤200k chars, diff_truncated), collect_error?}` — Atlas's own `.atlas/`, `.claude/commands/atlas-*` and `.github/prompts/atlas-*` excluded — and deletes the folder. A repo with no folder on disk falls back to the old empty temp dir; a repo that will not check out makes the sample `errored`.

- `verdict` ∈ `running | passed | failed | errored`. **`errored` is not `failed`**: a dispatch that never started is a broken environment, not a failing agent.
- `failures` is the ordered list of expectations that did not hold; empty on a pass.
- `item_id` records the throwaway item the run acted on, so a failure can be opened and read rather than guessed at.
- Judged at completion (`agent-tests-evaluate-run.ts`, called by `completeRun` and `errorRun`), with a fallback on read for a run the API missed by crashing. Before that hook existed a run nobody opened stayed `running` for good, and its verdict depended on whether anyone was watching.

**Sampling (migration 018).** An agent is stochastic, so one dispatch decided a verdict a second press could have reversed: a test that passes three times in five printed whichever of "passed" and "failed" the Owner happened to press. One press of Run is now a **batch** of `n` samples (`batch_id`, `sample_index`, cap 10), each materialising its own throwaway item — a second dispatch against an item the first already changed is measuring something else. Samples run in parallel, which is safe specifically because an agent test calls `spawnAgentRun` with no Task run, so each gets its own `mkdtemp` directory and never takes the project git lock.

- **No `agent_test_batches` table.** A batch has no state a row does not already carry and is derivable by `GROUP BY`; a table would need its own lifecycle, terminal-status logic and cleanup for data with none. Every run predating the migration was backfilled to a batch of one, so nothing downstream needs a "before sampling" case.
- The aggregate (`agent-test-batches.ts`) is **computed, never stored** — a stored verdict goes stale the moment one sample is re-judged. It reports `pass_at_1` (comparable with all pre-sampling history), `pass_at_k` ("can it do this at all"), `consistency`, `flaky`, and a `failure_histogram` saying *which* expectation was unstable and in how many samples.
- **`errored` never enters the denominator.** A CLI that was not installed is not an agent that got it wrong — the distinction `agent-tests-evaluate.ts` draws for one dispatch, kept at batch level instead of averaged away.
- `label` is a free-text tag on the run request (`before-prompt-diet`), for comparing two batches without a versions table.
- `judge_verdict` / `judge_reason` / `judge_cost_usd` are per-sample. The judge's cost is deliberately apart from `cost_usd` so an expensive judge can never fail a `max_cost_usd` expectation that is about the **agent**.

**Custom LLM-as-a-Judge (`services/agent-tests-judge.ts`).** Pass criteria in the Owner's own words, for the things a string comparison cannot ask — "did it explain *why* it rejected the work, or only that it did?". It is the only non-deterministic piece in the evaluation path, so six things hold it in place:

1. **Deterministic input** — the outcome summary, the reason and the trace JSON. Never the repo, never the diff, never the raw transcript. Same bytes in, same question out.
2. **Binary questions, not a paragraph** — `judge_criteria` is a list capped at 200 characters an entry by the route schema. A vague paragraph is the single largest source of judge variance.
3. **A fixed cheap model** — `haiku`, hardcoded. The judge is not the agent; changing an agent's model must not change its grade.
4. **Judged once, cached** — written at evaluation and never recomputed, so re-reading a run cannot change what it scored.
5. **Off by default** — no criteria, no spawn, no cost, no non-determinism.
6. **Measured, not assumed** — with more than one sample the judge's own agreement is visible beside the agent's.

**How it fails is the part that matters.** A judge that could not run, timed out, answered unreadably, or would not commit makes the run **`errored`** — never a pass, and never the agent's fault. Blaming an agent for a missing binary is the mistake `agent-tests-evaluate.ts` already refuses to make about the dispatch itself. Only a judge that read the block and said `rejected` produces a **failure**, and every judge-authored failure string carries a `judge:` prefix so a reader can always tell which assertion was machine-graded.

Its structured output reuses the `atlas-outcome` block the whole product already speaks (`done` → pass, `rejected` → fail, `asked_question` → abstained) rather than a bespoke JSON contract, which would be a second parser to write, cover and keep honest. Its cost goes through `parseClaudeCostFromOutput` directly rather than `agent-runner.ts`'s dispatcher — the runner imports the evaluator which imports the judge, so reaching back into it would close a cycle.

### IReminder
**Why this entity exists**: Owner-set (or Claude-set) future nudges fired by the minute tick; future-pointing intents, so they live apart from the notifications they produce.

Fields: `id, label, body, schedule_kind, schedule_value, channel, next_fire_at, last_fired_at, fire_count, created_by_agent_id, status, created_at, updated_at`

- `schedule_kind` ∈ `once | daily | weekly | cron`; `schedule_value` encodes it (`ISO` / `HH:MM` / `HH:MM|1,3,5` ISO weekdays / cron). Daily and weekly become an equivalent cron and, with cron, run in the Owner's zone (`settings.quiet_hours_timezone`); no zone → server time.
- `channel` ∈ `notification | external | both`.
- `fire_count` — computed: notifications with this `reminder_id` (not a column).
- Status: `active ⇄ paused` (PATCH `status`; resume recomputes `next_fire_at` from now) · `active | paused → cancelled` (DELETE) · `active → completed` (a once-reminder after it fires) · `completed | paused → active` (snooze). Cancelled is terminal; cancelled / completed rows can be hard-deleted (`?hard=1`). Only `active` rows fire.

### IReminderFire (view, not a table)
One logged fire: `notification_id, fired_at, push_status, external_status, failure_reason`, read from `notifications` by `reminder_id` (`GET /api/reminders/:id/fires`).

### IProjectSchedule
**Why this entity exists**: Different repos have different staleness tolerances (a documentation repo can fetch daily; a hot product repo wants every 15 minutes). Modeling schedules per-project rather than globally lets each repo carry its own cadence. The dirty / idle / agents guards live here because skipping a fetch is more situational than skipping a project â€” the policy needs to read the repo's live state at fire time.

Auto-fetch cron schedule per project.

Fields: `id, project_id, enabled, cron_expr, conflict_policy, dirty_guard, idle_guard, agents_guard, last_run_at, next_run_at, created_at, updated_at`

### IEnvVar (settings row helper, not a table)
**Why this shape exists**: Env vars need richer per-row metadata than a flat key/value map can carry â€” `secret` controls UI masking, `restart_required` triggers the restart-confirm dialog, `description` is the on-screen help. Modeling them as structured rows lets the Environment tab render them as a typed list rather than a textarea, which is what would happen with a raw `.env` file.

Each row has: `key, value, secret, restart_required, description`. The full set is mirrored to a `.env` file on save (services/env-file.ts).

---

## Relationships

```
Settings (single row, owner profile)

Credential 1 --- n Project
Project 1 --- n Task (items.type='task', no parent)
                  Task 1 --- n Sub-task (items.type='sub_task', parent_id = Task)
Project 1 --- n ProjectSchedule / ProjectGuardrail

Task.assignee_agent_id -------------> Agent        (the agent that runs the Task)
Task 1 --- n WorkflowRun (Task run) 1 --- n AgentRun n --- 1 Agent
WorkflowRun.workflow_id ------------> Workflow 'solo' (FK anchor only)
WorkflowRun.item_id ----------------> Task         (one live run per item)
WorkflowRunEvent.workflow_run_id ---> WorkflowRun  (park / resume history; CASCADE — migration 024)
JiraSource.agent_id ----------------> Agent        (imported Tasks are assigned to it — migration 020)
AgentRun.item_id -------------------> Task | Sub-task
Agent 1 --- n AgentChecklist / AgentPromptVersion; 1 --- 1 AgentMemory

Comments       polymorphic by (issue_type, issue_id)
Notifications  polymorphic by (issue_type, issue_id)
Notification.reminder_id ----------> Reminder   (fire log; ON DELETE SET NULL — migration 011)
Guardrails (global) workspace-wide, not project-linked
```

---

## Status machine

Source: `packages/shared/src/status-machine/index.ts`. Use `getValidNextStatuses(entityType, currentStatus)` and `isValidTransition(entityType, from, to)`. **Never hardcode status lists in components or routes.**

### Issue statuses (Tasks and sub-tasks — unified 6-state machine)

```
draft → ready → in_progress → in_review → done
                   │   ▲           │
                   ▼   │           ▼
                 ready │      in_progress
                       │
 any non-done ─▶ waiting_for_info ─▶ ready | in_progress
```

`FORWARD` in `packages/shared/src/status-machine/index.ts`: `draft→ready`, `ready→in_progress`, `in_progress→in_review|ready`, `waiting_for_info→ready|in_progress`, `in_review→done|in_progress`, `done` terminal; every non-`done` status may also move to `waiting_for_info`. The retired 10-state chain (`ready_for_po`, `in_spec`, `ready_for_dev`, …) and the 4-state sub-task machine no longer exist.

### `waiting_for_info` override

From any non-terminal state on a Task or sub-task, status can move to `waiting_for_info` (typically a Task run parking with the Owner). From `waiting_for_info` it moves to `ready` or `in_progress` (no prior-state memory).

### Transitions written by the Task runner

`agent-runner.ts` never writes item status. `packages/api/src/services/workflow-engine.ts` writes it directly (`setItemStatus`, with a `status_changed` event and `counts_changed` SSE), without going through `isValidTransition` — `in_progress → done` is not a status-machine edge, and the status machine is unchanged. The runner never changes the assignee.

| When | To | Event `detail` |
|---|---|---|
| Run start (`startTaskRun`) | `in_progress` | `run_started` |
| Park (question, missing outcome, rejection, unticked required checklist, step error after the retry, setup / worktree failure, reconcile, delivery failure) | `waiting_for_info` | `run_parked: <reason>` |
| A queued Task could not start (dispatch) | `waiting_for_info` | `run_start_failed: <message>` |
| Owner reply claims the parked run (`comments.ts`) / `POST /api/workflow-runs/:id/resume` | `in_progress` | `resumed_by_owner_reply` / `run_resumed` |
| Delivered (`finishRun`) | `in_review` when a PR opened, else `done` | `run_completed` |
| Stop (`cancelWorkflowRun`) | `waiting_for_info` | `run_cancelled` |

Assigning an agent to a `draft` Task moves it to `ready` (`tasksService.queueIfDraft`, event detail `queued_for_agent`). While a run is `running`, `PATCH …/status` and `…/assign` on its item return 409 (`workflow-lock.ts`). A parked run doesn't lock, so the Owner can move a `waiting_for_info` item by hand.

### Task dispatch

No agent has a queue or schedule of its own. `tickWorkflowDispatch` (one-minute tick in `agent-schedule-registry.ts`, plus `kickWorkflowDispatch` right away when a Task is queued, a queued Task turns `ready`, a Task reaches `done`, and at every delivery / stop) starts the oldest `ready` Tasks that have an assignee, no live run, no open `depends_on` target and no repo shared with another live run (one Task per repo at a time, ADR 0029), up to `MAX_PARALLEL_RUNS` (3) running at once. Parked runs hold no slot. Setting a Task `ready` without an assignee starts nothing; sub-tasks are never dispatched — the Task's agent works them inside the Task's run.

---

## Where the model touches each part of the codebase

| Concern | File |
|---|---|
| TypeScript interfaces | `packages/shared/src/types/index.ts` |
| Constants (categories, labels, accent colors) | `packages/shared/src/constants/index.ts` |
| Status transitions | `packages/shared/src/status-machine/index.ts` |
| Zod schemas (Create*, Update*) | `packages/shared/src/schemas/index.ts` |
| SQL schema | `packages/api/src/db/migrations/*.sql` |
| Run graph types (`IWorkflowGraph` — the frozen start → agent → end snapshot) | `packages/shared/src/workflows/index.ts` |
| Marketplace catalog sync (agents are installed, not seeded) | `packages/api/src/db/seed.ts`, `packages/api/src/marketplace/catalog/` |
| Web hook layer | `packages/web/src/hooks/*` |
| Web type-safe fetch | `packages/web/src/api/api.ts` |
