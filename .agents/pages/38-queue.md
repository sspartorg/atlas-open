# Queue

**Route:** `/queue` • **Component:** `packages/web/src/pages/Queue.tsx` • **Sidenav:** under WORKSPACE, immediately below Tasks (badge: `counts.queue`).

## Purpose
Atlas Open runs one agent at a time (`MAX_CONCURRENT_AGENTS` = 1, ADR 0033). This page shows what holds the slot, everything waiting for it in the order it will start, and which agents run on a schedule. Its list is `listDispatchQueue()` itself, so it never disagrees with what dispatch starts next.

## States
- Loading — `Skeleton` (rounded, 160px).
- Error — `Alert` "Could not load the queue."
- Populated — three `FormSection`s. Each has its own empty copy: "Nothing is running.", "Nothing is waiting.", and "No agent runs on a schedule. Turn one on from an agent's Overview."

## UI elements
**Page header** — title `Queue`, subtitle "One agent runs at a time. Everything else waits here in the order it will start."

**Running now · N / slots**
- One row per run holding the slot. The row shows:
  - an agent chip (accent colour)
  - a title link (`/tasks/:id` for a Task run, `/agents/:agentId/runs/:runId` for an itemless run)
  - the elapsed time in mono, re-ticked every 30 s
- **Stop** button (outlined, error). A Task run calls `POST /api/workflow-runs/:id/stop`; an itemless run calls `POST /api/run/:id/stop`.

**Waiting · N**
- Ordered rows, in dispatch order. Each shows its position number (mono), an agent chip and a title link.
- A blocked entry has a chip with the reason: "Repo busy" (ADR 0029), "Waiting on a dependency" (open `depends_on`) or "Waits for schedule" (its agent has a schedule and no pending fire). The first entry with no chip starts next.
- **Cancel** appears on itemless runs only (Run now, or an itemless agent's schedule) and calls `POST /api/run/:id/stop`. A Task leaves the queue from its own page: unassign it, or move it out of Ready.

**Scheduled · N**
- Active agents with `schedule_enabled`. Each row shows the agent chip (linking to `/agents/:id`), the cron expression in mono, and "Next: <absolute time>".
- A **Due** chip shows when a fire is pending. A **No item** chip shows when the agent runs on its own.

## Why these affordances exist
- **One list, from the dispatcher.** The Owner's question is "why hasn't my Task started?", and the blocked-reason chip answers it without guesswork.
- **Cancel only on itemless runs.** A Task's place in the queue is its status and assignee, and those are edited on the Task.

## Hooks used
- `useQueue()` — `['queue']`. SSE invalidates it on `run_queued`, `agent_status`, `run_completed`, `counts_changed` and `workflow_run_updated` (`useSSE.ts`).
- `useStopQueueEntry()` — stops or cancels, then invalidates `['queue']`.
- `useNow(30_000)`, `useSetPageTitle('Queue')`.

## API endpoints touched
- `GET /api/queue` — `IQueue { slots, running, waiting, scheduled }`.
- `POST /api/workflow-runs/:id/stop`, `POST /api/run/:id/stop`.

## Related
- The Dashboard `FleetStrip` links here with "1 slot · N waiting".
- Agent Detail → Overview → **Schedule & delivery** sets the schedule this page lists.

## Coming soon on this page
None.
