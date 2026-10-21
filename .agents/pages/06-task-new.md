# New Task

**Route:** `/tasks/new` • **Component:** `packages/web/src/pages/TaskNew.tsx` • **Slug:** `tasks`

## Purpose
Single-page form to draft a Task and either save it as a draft or submit it. Submit with an **Agent** picked assigns the Task to it, which queues it: that one agent runs the Task end to end in its own worktree and Atlas opens the pull request. Sub-tasks are added later on the Task's detail page (or by the agent, through MCP).

## States
- **Populated**: form; a pending create disables the action buttons.
- No explicit loading or error state — errors surface as a toast.

## UI elements
**Header / breadcrumb**
- Breadcrumb: Tasks › New task; title "New task" (`PageHeader`)
- Subtitle: `"<agent.name> will start once you submit"` when an agent is picked, else `"Nothing runs until the Task has an agent"`.

**Info banner** — `taskNewBannerCopy(agentName)`: "Write a rough goal — even one line is fine. <agent> starts as soon as you submit and opens a pull request when it is done." with an agent, else "… With no agent picked, the Task is saved as a draft until you assign one from its page."

**Form fields**
- **Title** — required, autoFocus; inline error on blur / submit.
- **Description** — multiline, required.
- **Project** — Select, required; pre-filled from `?project=<id or name>` once projects load (derived, not seeded into state — a fresh load used to leave it empty). Nothing in the app links with it today; it is for bookmarks and external links.
- **Repos** — shown whenever the picked project has any repo (ADR 0018): `RepoSelect` multi-select, the project's **first** repo preselected, order = pick order, helper "First repo holds specs and other Task-wide files." Always sent as `repo_ids`. With a project selected and nothing picked, Save/Submit are disabled; a project with no repos shows an info alert pointing at its Repos tab instead of the picker.
- **Priority** — `low | normal | high | urgent`; default `low`.
- **Agent** — `AgentSelect` over active agents, placeholder "None — save as a draft"; label hint "the agent runs this Task end to end and opens a pull request"; helper "Leave it empty to save a draft; Save as draft never starts it."
- **Reporter** — default `OWNER`; options Owner + active agents.

**Actions** (stay enabled; an invalid click sets `submitAttempted` and shows every field error)
- **Save as draft** — `POST /api/tasks` with `assignee_agent_id: null`: a draft is never queued, whatever the Agent select says. Toast "Saved as draft — <title>".
- **Cancel** — `/tasks`.
- **Submit** with an agent — `POST /api/tasks {…, assignee_agent_id}`: the API queues it in the same request (`queueIfDraft` in `services/tasks.ts`: draft → `ready`, a `status_changed` event with detail `queued_for_agent`, then a dispatch kick); toast "Submitted — <agent> is starting". No separate status call.
- **Submit** with no agent — same as Save as draft: the Task stays `draft`.
- Success navigates to `/tasks/:id`.

## Why these affordances exist
- **Draft vs Submit** — a draft stages the Task without queueing it; dispatch only picks up `ready` Tasks that have an agent.
- **Agent select** — picking the agent is the one decision that makes a Task run; "assign, then also set Ready" was one step too many, so assigning queues.
- **`?project=` pre-fill** — the common entry is from a project context.

## Modals / drawers
- **Discard draft?** (`DraftGuardProvider` → `ConfirmActionModal`) — when an app-level navigation (global `g`+`<key>` shortcut, Sidenav row, BottomNav / More sheet) would drop typed text.

## Hooks used
- `useCreateTask()` (`hooks/useTasks.ts`)
- `useProjects`, `useProjectRepos(projectId)`, `useAgents` (filtered to active), `useSettings`, `useToast`
- `useDraftGuard(dirty)` — dirty while Title or Description has text (`TaskNew.tsx:108`); also arms `beforeunload`.

## API endpoints touched
- `GET /api/projects/:id/repos` — once a project is picked
- `POST /api/tasks` (`repo_ids`; `assignee_agent_id` on Submit with an agent)

## Permissions / guards
- Post-onboarding only.

## Edge cases / quirks
- **The assignee is the runner** — one agent per Task; it runs once the Task is `ready`, at most `MAX_PARALLEL_RUNS = 3` Tasks at once and one Task per repo at a time (`workflow-engine.ts`).
- A create error (e.g. an agent deactivated since the list loaded) toasts the API's message; nothing is saved.
- "OWNER" is a select sentinel mapped to `null` in the payload.
- The draft guard covers app-level navigation only (`BrowserRouter`, no `useBlocker`); **Cancel**, the breadcrumb and the post-submit redirect leave without asking.
- Browser automation typing at ~4–5 ms per key drops ~1 char per 50 in these controlled fields; set values via the native setter + `input` event or type with a per-key delay (verified 2026-09-14, not an app bug).

## Connectivity
- **Pages**: [Tasks](05-tasks.md) — Cancel target and entry; [Task Detail](07-task-detail.md) — redirect after save.
- **Entities**: `task` (created), `project`, `agent` (reporter / assignee).

## Coming soon on this page
None.
