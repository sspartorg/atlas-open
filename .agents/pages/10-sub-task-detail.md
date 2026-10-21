# Sub-task Detail

**Route:** `/sub-tasks/:id` • **Component:** `packages/web/src/pages/SubTaskDetail.tsx` • **Slug:** `tasks`

## Purpose
One sub-task of a Task (ADR 0015). Sub-tasks never run on their own: only a Task is queued, and the Task's one agent works its sub-tasks inside the Task's run, on the Task's branch (the reorder dialog's order, skipping those in review or done). This page is where the Owner reads, edits and answers them.

## States
- **Loading**: `IssueDetailLoading`
- **Not found**: "Sub-task not found" + **Back to Tasks**
- **Populated**: shared `IssueDetailShell`

## UI elements
- **Test tag** — a sub-task made by an agent test run (`is_test`) shows a `TEST` pill beside the `+` add-related menu.

**Shell**
- Breadcrumb: Tasks → parent Task id (→ `/tasks/:taskId`) → sub-task id + `CopyLinkButton`.
- `EditableTitle` → `PATCH /api/sub-tasks/:id {title}`.
- **3-dots menu**: **Clone item** — `POST /api/tasks/:taskId/sub-tasks` with `Copy of <title>`, the description, acceptance criteria, labels, priority and assignee (the assignee is informational — only the Task's agent runs), then a `relates_to` link back to the source, then navigates to the clone (`SubTaskDetail.tsx` `handleClone`). A failed create toasts "Couldn't clone <id>" and stays put; a failed link-back still opens the clone and toasts "Cloned as <new>, but couldn't link it to <id>". Below a divider: **Delete** (→ parent Task).
- **`AddRelatedMenu`** (`+`): **Link an item**, **Add dependency** → `LinkPickerDialog` (same names as the card buttons and the dialog titles).

**Body cards**
- **Description**, **Acceptance criteria** — `EditableMarkdownCard` → `PATCH /api/sub-tasks/:id`.
- `RelatedItemsCard` with `allowAddTestLink` — **Tested by** / **Tests** section (`tested_by` twin links) always offers **Add test link**; that picker is restricted to sub-tasks of the same Task (`restrictToTaskId`). Blocked by / Relates to / Pull Requests hide while empty.
- **Pull Requests row actions** — **Add PR link** opens `AddPrLinkDialog` (GitHub PR URLs only). Each row carries a **Remove PR link** icon button (`aria-label="Remove PR link"`) which opens a `ConfirmActionModal` before anything is deleted: it unlinks the row and clears `items.pr_url` when that column points at the same PR, and says plainly that the pull request itself stays open on GitHub — nothing is closed, merged or deleted there.
- `ConversationCard` — while the sub-task is `waiting_for_info` and its latest agent run belongs to a Task run, helper text reads "Replying continues the waiting run."

**Right rail**
- `DetailsRailCard`: Project, **Task** parent link, Status (with Override), Assignee — Status and Assignee lock (lock icon, no picker) while a run record is `running` on this item, the API's own rule (`GET /api/items/:id/workflow-runs`; runs are Task-level, so in practice this does not fire) — Reporter, Priority, Labels, Total cost, Created, Updated. No run rows and no Branch / Path — the sub-task shares its Task's worktree.
- `ActivityLogCard`.

## Why these affordances exist
- **Labels** — free-form tags with project suggestions; they filter Search and lists.
- **Test links** — a test sub-task points at the sub-task it covers via `tested_by` (test → dev).

## Hooks used
- `useSubTaskFull(id)`, `useDeleteSubTask`, `useCreateSubTask`, `useUpdateSubTask`, `useTransitionSubTask`, `useAssignSubTask` (`hooks/useSubTasks.ts`) — every failed write toasts "Couldn't save / move / reassign <id>" with the API's reason; title, description and labels editors stay open on failure
- `api.issueLinks.create` directly (Clone link-back)
- `useItemAgentRuns(id)`, `useProjectLabels(projectId)`, `useSettings`

## API endpoints touched
- `GET /api/sub-tasks/:id/full` — sub-task + parent `task` + project + links + activity + agents
- `PATCH /api/sub-tasks/:id` (title, description, acceptance_criteria, priority, labels), `PATCH /api/sub-tasks/:id/status`, `PATCH /api/sub-tasks/:id/assign`, `DELETE /api/sub-tasks/:id`
- `POST /api/tasks/:taskId/sub-tasks` + `POST /api/issues/sub_task/:id/links` (Clone)
- `POST /api/issues/sub_task/:id/external-links/refresh` (Done guard)

## Edge cases / quirks
- A finished sub-task is `in_review`, not `done`: the Owner closes it after checking the Task's branch (or it closes with the Task when the PR merges).
- Creating a sub-task while its Task's run is live is fine; the agent reads the Task (with its sub-tasks) through MCP `get_item`.

## Connectivity
- **Pages**: [Task Detail](07-task-detail.md) (parent; Sub-tasks table), [Run Detail](37-run-detail.md) (the Task's run).
- **MCP tools**: `get_item { issue_type: 'sub_task', id }` (includes the parent `task`); `create_item { issue_type: 'sub_task', payload: { task_id, … } }`.
- **Entities**: `sub_task`, `task` (parent), `agent`.

## Coming soon on this page
None.
