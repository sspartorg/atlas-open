# Run Detail

**Route:** `/runs/:runId` • **Component:** `packages/web/src/pages/runs/RunDetail.tsx` • **Slug:** `tasks`

## Purpose
One Task run: the Task's assigned agent working it end to end in its own worktree, then Atlas committing its edits, pushing and opening the PR (agents never commit). Shows the run's status, its agent step(s), the PR(s), and the code it changed — and lets the Owner **Stop** or **Resume** it.

The run record is a `workflow_runs` row on the built-in `solo` workflow (seeded by `001_baseline.sql`; graph start → agent → end, `soloGraph` in `services/workflow-engine.ts`). The internal names (`workflow_runs`, `/api/workflow-runs/*`, `useWorkflowRun`, `workflow_run_updated`) are the run record's; there is no workflow builder in Atlas Open.

## States
- **Loading**: centred spinner.
- **Not found**: "Run not found."
- **Populated**: header, banner (when relevant), Steps card, Changes section.

## UI elements
**Header**
- Breadcrumb: Task id (→ `/tasks/:id`) › **Run** (or **Tasks** › Run for a run with no item).
- H1: the Task title (`item_title`, "Project run" when there is none) + `RunStatusChip`.
- Meta line: Task id (mono, or the run id's first 8 chars) · "started <relative>" (absolute time on hover) · duration (`Xh Ym` / `Xm SSs`, ticking from `finished_at` or now) · total cost · branch (mono, when set).
- Actions: **Resume** (contained, only `waiting_for_owner`) → `POST /api/workflow-runs/:id/resume`; **Stop** (outlined, error colour, while `running` or `waiting_for_owner`) → `POST /api/workflow-runs/:id/stop`; one **Pull request** button per PR (`pr_urls`, falling back to `pr_url`; "Pull request N" when a multi-repo Task delivered several), opening GitHub in a new tab. A failed action toasts "Could not resume/stop run" with the API's detail.

**Banner** (`RunBanner`)
- `waiting_for_owner` — warning: the `park_reason` (bold) then "The run is waiting for you. Reply on the Task to continue — open <id>." (a reply on the Task resumes the run).
- `completed` with a PR — success: "Delivered — open the pull request".
- `error` — "The run stopped on an error. Check the agent's log."

**Steps** (`section aria-label="Steps"`, overline "Steps · N")
- One `StepRow` per agent run of this Task run (normally one; a crashed step's automatic retry, or a re-run after an Owner reply, adds another): status dot, agent name, status, outcome kind chip, `outcome_summary — outcome_reason`, `cli · model · effort` line, duration and cost on the right. Row click / Enter → `/agents/:agentId/runs/:stepId` ([Agent Run Detail](16a-agent-run-detail.md)).
- Empty: "The agent has not started yet."

**Changes** (`RunChangesSection`, `section id="changes" aria-label="Changes"`)
- Fetched lazily: only once the section nears the viewport (`IntersectionObserver`) or the URL hash is `#changes` (the Task rail's **View changes** link); then it scrolls itself into view.
- One tab per repo (`aria-label="Repository"`) when the run touched more than one.
- Per repo: a caption — "Read from the run's checkout." or "Read from the run's branch — its checkout was removed after delivery." plus "Compared with <base_ref>." — then the read-only two-pane diff (`StopSessionReviewPanel` from the terminal Stop modal) with **Uncommitted / Committed** scope, view mode and wrap (remembered per browser via `loadDiffPrefs`).
- A repo whose diff cannot be read shows its `reason` as an info alert; no checkout at all: "This run has no repository checkout, so there are no code changes to review."; a fetch error: "Could not load the changes. <message>".

**`RunStatusChip`** — pill from `WORKFLOW_RUN_STATUS_PALETTE`: Running · Waiting for you · Completed · Cancelled · Error.

## Entry points
- **Task rail** — `TaskRunPanel` (`pages/runs/TaskRunPanel.tsx`, mounted by `DetailsRailCard` on Tasks): the **Run** row's chip links here; **View changes** links to `#changes`. The panel also offers Resume / Stop itself. See [Task Detail](07-task-detail.md).
- **Agent Run Detail** — **Open Task run** when the agent run belongs to a Task run.

## Why these affordances exist
- **Stop / Resume here and on the rail** — a run parks on the Owner (a question, a rejection, a red required checklist item, a failed delivery, a second crash); the Owner either replies on the Task or resumes after fixing the cause (e.g. a project credential), and a resumed run re-tries delivery against the kept worktree.
- **Changes in Atlas** — review the agent's code before (or instead of) opening GitHub; it still works after delivery removed the checkout, by reading the pushed branch.

## Hooks used
- `useWorkflowRun(runId)` — `['workflow-run', runId]`, `GET /api/workflow-runs/:id`.
- `useStopWorkflowRun`, `useResumeWorkflowRun` (`hooks/useRuns.ts`).
- `useWorkflowRunDiff(runId, near)` — `['workflow-run-diff', runId]`; the file patch via `useWorkflowRunFilePatch` inside the review panel.
- `useToast`, `useSetPageTitle`.
- Live via SSE: `workflow_run_updated` invalidates `['workflow-run', id]` and `['item-workflow-runs', itemId]`.

## API endpoints touched
- `GET /api/workflow-runs/:id` — run + `steps` (its agent runs) + `item_title`, `pr_urls`, `park_reason`, cost.
- `GET /api/workflow-runs/:id/diff`, `GET /api/workflow-runs/:id/diff/file?repo_id&path&scope&context`.
- `POST /api/workflow-runs/:id/stop`, `POST /api/workflow-runs/:id/resume` (`requireMcpToken`; resume maps start errors to 404/409/400).

## Edge cases / quirks
- Stopping keeps what the agent committed but opens no PR.
- Resuming a run parked for days first refreshes its branch onto the latest default branch.
- At most `MAX_PARALLEL_RUNS = 3` Tasks run at once, and one Task per repo at a time (ADR 0029); a queued Task waits on the Tasks page until a slot frees, so it has no run yet.
- While a run is `running` its Task's status and assignee are locked (409 from `workflow-lock.ts`); a parked run does not lock.

## Connectivity
- **Pages**: [Task Detail](07-task-detail.md), [Agent Run Detail](16a-agent-run-detail.md).
- **Entities**: `workflow_run` (Task run record), `workflow_run_event`, `agent_run`, `task`.

## Coming soon on this page
None.
