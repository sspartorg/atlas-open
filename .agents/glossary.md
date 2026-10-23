# Glossary

Domain terms used throughout Atlas. One line each. When in doubt, this file wins over assumptions from training data.

| Term | Meaning |
|---|---|
| **Owner** | The single human running the app. Implicit — there is no users table. Defaults to the name typed in onboarding. Runs escalate (park) to the Owner only; agents never route items. |
| **Agent** | An AI worker profile: a CLI choice (`claude` / `copilot` / `ollama`), model, effort, prompt (`prompt_md`), memory and checklists. Carries no schedule, routing or git flags — it runs as a Task's assigned agent or as an ad-hoc run. Installed from the marketplace catalog; none are seeded. |
| **Agent category** | One of `software-dev | marketing | content | design`. Drives card grouping on the Agents page. |
| **CLI** | The command-line tool an agent invokes â€” `claude` (Anthropic), `copilot` (GitHub), or `ollama`. Mapped in `agent-runner.ts`. `ollama` is not a separate binary: it runs Claude Code against Ollama's Anthropic-compatible API on `ATLAS_OLLAMA_BASE_URL` (default `http://localhost:11434`), so it shares Claude's argv, transcripts, and resume behaviour and costs $0. See **CLI dialect**. |
| **CLI dialect** | Which binary + argv shape a `cli` value actually speaks â€” `claude` or `copilot`. `CLI_DIALECT` in `@atlas/shared` maps `ollama â†’ claude`. Always branch on the dialect, never on the raw `cli` value, or Ollama silently falls into the Copilot path. |
| **Model** | A model identifier registered under a CLI (e.g., `claude-opus-4-7`, `gpt-5.5-coder`). Maintained in Settings â†’ Model Registry. Only registered models appear in agent pickers. |
| **Framework** | A label on each agent indicating its operating style (e.g., "Anthropic PO Framework"). Influences prompt assembly. Does not change behavior on its own. |
| **Task** | The top-level item (`items.type='task'`, ADR 0015), scoped to a Project. Assigning an agent queues it (`queueIfDraft` → `ready`); its one run does the work on one branch and delivers one PR per repo it changed. Carries acceptance criteria, `spec_md` and the run's `pr_url`. |
| **Sub-task** | A Task's only child kind (`items.type='sub_task'`). Never runs on its own; only Tasks are dispatched. Stories, bugs, old sub-tasks and sub-bugs were converted into sub-tasks by an earlier migration. |
| **Run** | One invocation of an Agent. Stored in `agent_runs`. Status `queued \| in_progress \| completed \| error \| cancelled \| setup_failed`. Either the agent **step** of a Task run (`workflow_run_id` + `node_id` set) or an ad-hoc `POST /api/run` with no item. |
| **Queue** | Ready Tasks with an assigned agent and no live run, started oldest first (`oldestReadyItem` in `services/workflow-engine.ts`) up to `MAX_PARALLEL_RUNS` (3), one Task per repo at a time (ADR 0029). There is no queue page. |
| **Guard-rail** | A safety rule. Two scopes: workspace-wide (`guardrails` table, `/guardrails` page) and per-project (`project_guardrails` table, surfaced on the Project Detail â†’ Guard-rails tab). |
| **Severity (guard-rail)** | `block` (agent must refuse), `ask_owner` (agent must ping you first), `warn` (agent proceeds but flags). |
| **Constitution** | Markdown blob in `settings.constitution_md` â€” a workspace-wide preamble injected into every agent's prompt. Edited in Settings. |
| **Quiet hours** | A daily window during which outward (Telegram/Teams) deliveries are held and sent one by one when it ends, each marked with its original time. `from == to` means off. In-app and web push are not affected. Configured in Settings → Notifications. |
| **Task run** | One run of a Task by its assigned agent: a `workflow_runs` row (the historical name of the run record) on the built-in `solo` workflow (migration 020), whose frozen `graph_snapshot` is always start → agent → end (`soloGraph`). Owns one worktree + branch (`atlas/task/<id>`), delivers at the end (Atlas commits the agent's edits as `<key>: <title>`, pushes, opens the PR — agents never commit). Status `running \| waiting_for_owner \| completed \| cancelled \| error`. At most one live run per item. Shown at `/runs/:runId`. |
| **Step** | The agent's `agent_runs` row inside a Task run (`workflow_run_id` + `node_id`). A crashed step gets one automatic retry (the retry carries `parent_run_id`); a second crash parks the run. |
| **Park** | Handing a Task run to the Owner: run `waiting_for_owner`, item `waiting_for_info`, a comment + notification, worktree kept. Caused by `asked_question`, `rejected` or an unticked required checklist row, a missing outcome, a repeated crash, a missing agent or a failed delivery. An Owner comment on the item (or `POST /api/workflow-runs/:id/resume`) resumes it. |
| **Outcome block** | The fenced `atlas-outcome` block every agent ends with (`done` / `rejected` / `asked_question`, plus `summary`, `reason`, `checklist`). Contract staged as `.atlas/outcome.md`; Atlas decides on it whether to deliver or park. |
| **Workflow** | Not in this edition. The commercial Atlas adds Owner-designed workflow graphs; in Atlas Open the `workflows` table holds only the `solo` FK anchor (and inactive rows from an upgraded install). |
| **Tool catalog** | Read-only directory of the Atlas MCP tools (`tool_catalog`), re-synced from `@atlas/mcp` registrations on every boot. No per-agent enforcement. |
| **Auto-fetch** | A scheduled `git fetch` per **repo** (ADR 0018). Configured from Project Detail's Repos tab via the AutoFetchScheduleModal; jobs registered per repo id in `services/schedule-registry.ts`. |
| **Conflict policy / dirty guard / idle guard / agents guard** | Per-schedule rules that decide whether to skip a fire if the worktree is dirty / an agent is running / etc. |
| **Reclone** | Internal name (route, runner, SSE events) for the Repos tab's **Pull from remote**: stash local changes if dirty, `git fetch --prune`, `git pull --ff-only`. It does not wipe or re-clone. |
| **Workspace** | The root folder selected during onboarding. Holds every project's clone and worktrees. Data lives in Postgres. |
| **ATL-12** (and similar) | Item ids: `<project issue_key_prefix>-<seq>`, one counter per project shared by Tasks and sub-tasks (`services/items.ts::createItem`). Used as-is in headers, tables and URLs (`/tasks/ATL-12`). |
| **AppShell** | The post-onboarding layout: Sidenav (left) + Topbar (top) + Outlet for the routed page. Lives in `App.tsx`. |
| **In-app feed** | Notifications surfaced inside the app (`/notifications` â†’ In-App tab). Separate stream from external notification deliveries. |
| **`waiting_for_info`** | Status of an item whose run parked with the Owner (or that the Owner set by hand). Reachable from any non-`done` status. |
| **`ATLAS_AI_ENABLED`** | Env flag. When not `true`, `agent-runner.ts` emits canned output instead of spawning a real CLI â€” used for dev without CLI cost. |
