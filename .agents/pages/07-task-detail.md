# Task Detail

**Route:** `/tasks/:id` • **Component:** `packages/web/src/pages/TaskDetail.tsx` • **Slug:** `tasks`

## Purpose
Full view of one Task (ADR 0015): its brief (description, acceptance criteria), its spec (when one was written), the one PR its agent run opened, its sub-tasks, links, conversation and activity. The rail is where the Owner assigns the Task's agent (which queues it) and follows, stops or resumes its run.

## States
- **Loading**: `IssueDetailLoading withBreadcrumb`
- **Not found**: "Task not found" + **Back to Tasks**
- **Populated**: shared `IssueDetailShell` (`pages/issues/IssueDetailShell.tsx`)

## UI elements
- **Test tag** — a Task made by an agent test run (`is_test`) shows a `TEST` pill beside the `+` add-related menu.

**Shell**
- Breadcrumb: Tasks → Task id (mono) + `CopyLinkButton`.
- `EditableTitle` → `PATCH /api/tasks/:id {title}`.
- **3-dots menu** → `IssueDeleteAction` (Delete → `ConfirmDeleteModal`, "every sub-task, comment, and run history will be removed"), then `/tasks`.
- **`AddRelatedMenu`** (`+`): **Link an item**, **Add dependency** → `LinkPickerDialog` (candidates: every Task and sub-task).

**Body cards** (in order)
- **Description** and **Acceptance criteria** — `EditableMarkdownCard`s → `PATCH /api/tasks/:id`. A Jira-imported description ends with the bridge-managed `## Attachments from Jira` / `## Comments from Jira` sections; `MarkdownPreview` renders `![…](/api/jira-attachments/<id>)` as an inline image (no other image URL is rendered).
- **Spec** — read-only `MarkdownPreview` of `spec_md`; only when non-empty (`spec_md`, set through the API/MCP).
- **Pull request** — link to `pr_url`; only when set (the run's delivery writes it after it opens the PR).
- **Sub-tasks** — `WorkItemTable` of `sub_tasks` (id, title, status, labels, assignee, reporter, updated); row → `/sub-tasks/:id`. Rows come in run order (hand-set order, then oldest first). Header **Reorder** (2+ sub-tasks) opens `ReorderSubTasksDialog` (`pages/tasks/`, title "Reorder sub-tasks"; "The Task's agent works its sub-tasks top to bottom, one at a time, skipping any that are in review or done."): up / down per row ("Move ATL-3 up"), **Save order** (disabled until the order changes) → `PUT /api/tasks/:id/sub-tasks/order`. Header **Add sub-task** opens the inline `AddSubTaskForm` (Title required, Description, Acceptance criteria, Labels with project suggestions) → `POST /api/tasks/:id/sub-tasks`; typed text arms `useDraftGuard`.
- `RelatedItemsCard` — Blocked by / Relates to / Tested by / Pull Requests sections, each hidden while empty. A Task imported by the Jira bridge (ADR 0016) also shows a **Jira** section above Pull Requests: its `jira_issue` link as the key in mono, the issue summary and an open-in-new icon. The link opens the Jira issue in a new tab and has no remove button. The Pull Requests list shows `pull_request` links only. No "Add test link" here (`allowAddTestLink` omitted — a Task isn't a `tested_by` source).
- **Pull Requests row actions** — **Add PR link** opens `AddPrLinkDialog` (GitHub PR URLs only). Each row carries a **Remove PR link** icon button (`aria-label="Remove PR link"`) which opens a `ConfirmActionModal` before anything is deleted: it unlinks the row and clears `items.pr_url` when that column points at the same PR, and says plainly that the pull request itself stays open on GitHub — nothing is closed, merged or deleted there. Next to each PR's state chip (Open / Merged / Closed) sits a **CI chip** when the API has seen CI for the PR's head commit: **CI passed** (success), **CI running** (warn), **CI failed** (danger); its tooltip lists the failing checks (`name (title)`). No chip when `ci_state` is null — a repo without CI does not read as green.
- `ConversationCard` — thread + composer. The thread shows the newest 50 comments; **Show N earlier · M hidden** loads 200 more (the Activity log card pages the same way). While the Task is `waiting_for_info` and its latest agent run belongs to a Task run (`agent_runs.workflow_run_id` set), helper text reads "Replying continues the waiting run." (`ActivityCard.tsx`). The reply resumes the parked run.

**Right rail**
- `DetailsRailCard`: Project, **Repos**, Status (`StatusPickerPopover`, with Override), Assignee (`AssigneePickerPopover`, PO-role agents under **Suggested**) — the agent that runs the Task. Assigning an agent to a **Draft** Task moves it to **Ready**, which queues it (`queueIfDraft` in `services/tasks.ts`); assigning on a Ready Task kicks dispatch so the run starts within seconds when a slot is free. Status and Assignee lock (lock icon "Locked while a run works this item", no picker) while a run is `running` on the Task — the API's own 409 rule, read from `useItemWorkflowRuns`. Then the `TaskRunPanel` rows (below), Reporter, Priority, Labels (`useProjectLabels`), Total cost (sum of `useItemAgentRuns`), **Branch** / **Path** (`worktree_branch` / `worktree_path`; copy buttons "Copy branch" / "Copy path"), Created, Updated. Rail rows are keyboard buttons.
- **Repos** row (`TaskReposRow`, ADR 0017/0018) — the Task's `repo_ids` as mono chips in order (a pre-0018 `[]` falls back to the project's first repo). Clickable only when the project has more than one repo: opens a small **Repos** dialog (`RepoSelect`; the first repo holds Task-wide files) → **Save** → `PATCH /api/tasks/:id {repo_ids}`. A refusal toasts "Couldn't save <id>" with the API's reason (a live run: the API refuses repo changes until it is stopped). With more than one repo, **Path** gets an info icon with the tooltip "Workspace folder — one checkout per repo".
- `TaskRunPanel` (`pages/runs/TaskRunPanel.tsx`, Tasks only; renders nothing until the Task has a run) — the latest run from `GET /api/items/:id/workflow-runs`: **Run** — status chip + relative start time (→ `/runs/:runId`, see [Run Detail](37-run-detail.md)); **Waiting on you** — the `park_reason` while `waiting_for_owner`; **Agent run** — the agent's name, linking to its log (`/agents/:agentId/runs/:stepId`); **Changes** — **View changes** (→ `/runs/:runId#changes`) once the run has a branch; **Pull request** (one row per PR, "Pull request N" when several repos delivered) → GitHub; **Actions** while the run is live — **Resume** (`waiting_for_owner` only, `POST /api/workflow-runs/:id/resume`) and **Stop** (`POST /api/workflow-runs/:id/stop`). A failed action toasts "Could not resume/stop run". A step that crashes is retried once automatically before the run parks on the Owner.
- Status → **Done** while any `pull_request` link isn't `merged`: `POST /api/issues/task/:id/external-links/refresh` first; still unmerged → **Mark done anyway?** (`ConfirmActionModal`) listing the PRs.
- `ActivityLogCard` — status / assignment / field events.

## Why these affordances exist
- **Sub-tasks on the Task page** — there is no sub-task list page; a Task's sub-tasks are the contents of its one PR, so they live with it.
- **Assignee is the run trigger** — one agent per Task; sub-tasks are worked inside the Task's run, on its branch.
- **Spec / PR as read-only cards** — written by the agent (spec) and by delivery (PR); the Owner reads them here.

## Hooks used
- `useTaskFull(id)` — `['tasks', id, 'full']` → `GET /api/tasks/:id/full`
- `useTransitionTask`, `useAssignTask`, `useUpdateTask`, `useDeleteTask` (`hooks/useTasks.ts`); `useCreateSubTask` (`hooks/useSubTasks.ts`). Every failed Task write toasts with the API's reason — "Couldn't move / reassign / save <id>" (status 409/400 and network errors included; the closure 422 keeps its own toast). Title, description, acceptance-criteria and labels editors stay open on failure. Comment post / edit / delete failures toast "Couldn't post / save / delete the comment" (`useComments`, `useDeleteComment`) and keep the draft / dialog.
- `useItemAgentRuns(id)`, `useProjectLabels(projectId)`, `useSettings`, `useDraftGuard`
- Repos row: `useProjectRepos(projectId)`
- `TaskRunPanel`: `useItemWorkflowRuns(id)`, `useWorkflowRun(latestId)`, `useStopWorkflowRun`, `useResumeWorkflowRun` (`hooks/useRuns.ts`)

## API endpoints touched
- `GET /api/tasks/:id/full`
- `PATCH /api/tasks/:id` (title, description, acceptance_criteria, priority, labels, repo_ids)
- `GET /api/projects/:id/repos` (Repos row), `PATCH /api/tasks/:id/status`, `PATCH /api/tasks/:id/assign`, `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/sub-tasks`
- `GET /api/items/:id/workflow-runs`, `GET /api/workflow-runs/:id`, `POST /api/workflow-runs/:id/{stop,resume}` (the Task run record; internal names keep `workflow`)
- `POST /api/issues/task/:id/links`, `POST /api/issues/task/:id/external-links/refresh`

## Edge cases / quirks
- **Closing a Task with open sub-tasks** → 422 (`ChildrenNotDoneError`) unless the Override path is used.
- While the Task's run is `running`, status / assign PATCHes 409 (`workflow-lock.ts`); stop the run to take the Task back. A parked run doesn't lock.
- A finished run leaves the Task `in_review` when it opened a PR or any sub-task isn't `done`; the Owner closes the sub-tasks and then the Task after verifying the branch.

## Connectivity
- **Pages**: [Tasks](05-tasks.md), [New Task](06-task-new.md), [Sub-task Detail](10-sub-task-detail.md) (rows), [Run Detail](37-run-detail.md) (rail chip), [Analytics — Task](32-analytics-task.md).
- **MCP tools**: `get_item { issue_type: 'task', id }` returns the Task + `sub_tasks` + project + comments + links + activity.
- **Entities**: `task`, `sub_task`, `workflow_run` (Task run record), `comment`, `issue_event`, `agent`.

## Coming soon on this page
None.

**Closing a verified Task.** Choosing **Done** while only `in_review` sub-tasks block it shows a toast "N sub-task(s) in review — Close them with the Task?" with **Close them too** → the same PATCH with `close_sub_tasks: true`. Any sub-task still open keeps the usual "Cannot close — open children" toast. When the Task's PR merges on GitHub, the Task and its reviewed sub-tasks close by themselves (`external-links.ts` `closeMergedTask`; the scheduler re-checks in-review Tasks' PRs every tick, TTL 5 min). **CI (migration 023):** the same tick reads CI on each open PR's head commit for the PR chips; Atlas Open does not fix red CI automatically. **Path** in Details shows the latest run's worktree while that folder exists.

