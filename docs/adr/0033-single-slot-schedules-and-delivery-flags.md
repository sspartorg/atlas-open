# 0033. One Agent at a Time, Agent Schedules and Per-Agent Delivery Flags

**Date:** 2026-10-27
**Status:** Accepted

## Context

Atlas Open is the free edition of Atlas. It has no workflow builder, so the agent itself has to say everything a workflow used to say about a run. Before this decision, three things were hardcoded or missing:

- **Concurrency.** Dispatch started up to three Task runs at once (`MAX_PARALLEL_RUNS = 3`, `services/workflow-engine.ts`). "Run now" spawned an itemless run straight away, outside any cap (`routes/run.ts`).
- **Scheduling.** Agents had no schedule. The columns were dropped with ADR 0014 (migration 036), and `marketplace/catalog-loader.ts` stripped `requires_item` and `schedule_*` from manifests. The minute tick (`agent-schedule-registry.ts`) never fired an agent.
- **Git delivery.** Every finished Task run committed, pushed and opened a PR (`finishRun` → `deliver(run, { openPr: true })`). The `workflows.push_code` / `raises_pr` columns existed but nothing read them.

The free edition should run one long agent session at a time, which keeps token spend predictable. The Owner needs each agent to say three things: whether it needs a Task, when it starts, and what Atlas does with its changes.

We rejected the alternatives:

- **A per-project concurrency setting.** The cap is a property of the edition, not a preference.
- **One delivery enum.** The Owner asked for three switches; they are chained in the UI, the Zod schema and a DB CHECK, so an invalid combination cannot exist.

## Decision

- **One slot.** `MAX_CONCURRENT_AGENTS = 1` (`@atlas/shared`). The slot is held by every `running` Task run plus every started itemless agent run. Parked runs do not hold it. Agent test runs do not hold it either, because they QA the agent rather than do its work.
- **One queue.** `listDispatchQueue()` (`services/workflow-engine.ts`) lists ready, assigned Tasks and itemless runs waiting for the slot, oldest first. Each entry carries a `blocked_reason` (`dependency`, `repo_busy` or `awaiting_schedule`). Dispatch starts the first entry that is not blocked. `GET /api/queue` and the Queue page show the same list.
  - "Run now" and an itemless agent's schedule both insert an `agent_runs` row with status `queued` and `started_at` null. Dispatch claims the row by setting `started_at`, then spawns it.
- **Agent run config** (migration 004, on `agents` and `marketplace_agents`):
  - `requires_item`: true means the agent works Tasks. False means it runs on its own in a scratch dir, never touches git, and cannot be assigned a Task (the API returns 400).
  - `git_commit`, `git_push`, `git_open_pr`: what `deliver()` does when a Task run ends. They are chained: a push needs a commit, and a PR needs a push.
  - `schedule_enabled` plus the preset fields (the same shape as the per-repo auto-fetch schedule) and the derived `schedule_cron_expression`.
- **A schedule gates pickup** (`services/agent-schedules.ts`):
  - Each minute, every active agent whose `schedule_next_run_at` has passed advances to its next fire.
  - A Task agent is marked due (`schedule_due_at`). The fire buys its oldest startable Task. A fire with no startable Task is dropped.
  - An itemless agent gets one queued run.
  - Missed fires collapse into one.
  - An agent without a schedule picks up its ready Tasks as soon as the slot frees.
- **Unpushed work is never cleaned up.** The worktree and branch are removed only after a successful push. With commits off, Atlas refuses to reset a worktree an earlier run left dirty, and parks the run (`setup_failed`).

## Consequences

- One agent at a time means a long run delays everything behind it. The Queue page shows why each Task is waiting.
- ADR 0029's one-Task-per-repo rule still applies. With one slot, it only matters while a run is parked.
- "Commit off" leaves the Task `done` with its changes in a worktree on disk. The Owner has to finish that work by hand, and the completion notification says where it is.
- Catalog agents that need no item (AI News, Market Research, Regulations, Jira → Tasks) ship `requires_item: false` with a suggested schedule that is turned off. Agents installed before this change keep the defaults (works a Task, commit + push + PR) until the Owner changes them.
- A Marketplace upgrade does not overwrite an agent's run config. The run config belongs to the Owner once the agent is installed.
