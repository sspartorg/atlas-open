# Routes Map

One row per web route. Cross-link to `pages/*.md` for detail. Sources: `packages/web/src/App.tsx:98-272`, `packages/web/src/components/Sidenav.tsx:24-69`.

---

## Top-level routes

| Route | Page component | Key hooks | Main API endpoints | Modals / drawers | Coming-soon items |
|---|---|---|---|---|---|
| `/onboarding` | `Onboarding` | `useSettings`, `useNavigate` | `POST /settings/onboard` | FolderPicker (native dialog) | â€” |
| `/` | `Dashboard` | `useSettings`, `useProjects`, `useDashboard`, `useAgentSummaries`, `useActiveRuns` | `GET /projects`, `GET /dashboard`, `GET /agents?view=summary`, `GET /run?status=queued,in_progress` | `NewProjectModal` (from empty state) | â€” |
| `/projects` | `Projects` | `useProjects`, `useProjectsPaged`, `useAllRepos`, `useTasks`, `useAgents`, `useSettings`, `useEnabledSchedules` | `GET /projects`, `GET /projects/paged`, `GET /repos`, `GET /tasks`, `GET /agents?view=summary` | `NewProjectModal`, `DeleteProjectModal` | Reclone / auto-fetch / reveal moved to Project Detail's Repos tab (ADR 0018) |
| `/projects/:id` | `ProjectDetail` (7 tabs: Overview, Tasks, Guard-rails, Repos, Jira, Setup, History) | `useProject`, `useIssues({projectId})`, `useProjectCounts`, `useAgents`, `useSettings`, `useProjectEnv`, `useSaveProjectEnv`, `useProjectRepos`, `useCloneProjectRepo`, `useConnectProjectRepo`, `useUpdateProjectRepo`, `useRemoveProjectRepo`, `useCloneJob`, `useCredentials`, `useProjectJiraSources` | `GET /projects/:id`, `GET /issues/tree?project_id=…`, `GET /counts/project/:id`, `GET /run?project_id=…`, `GET/PUT /projects/:id/env`, `GET/POST /projects/:id/repos`, `PATCH/DELETE /projects/:id/repos/:repoId`, `GET/POST/PATCH/DELETE /projects/:id/jira-sources`, `POST /projects/:id/generate-ai-scaffold` | `DeleteProjectModal`, `ProjectEnvSecretsModal`, `AddRepoDialog`, `EditRepoDialog`, remove-repo `ConfirmActionModal` | Rename, Edit repo URL, Change default branch, Notification routing, Archive — `stubMessage` toasts in `ProjectActionsMenu.tsx` |
| `/projects/:id/guard-rails` (alias: `/projects/:id/guardrails`) | `ProjectGuardrails` (redirects to `/projects/:id?tab=guardrails`) | `useProjectGuardrails`, `useCreateProjectGuardrail`, `useToggleProjectGuardrail` | `GET/POST/PATCH /projects/:projectId/guardrails`, `PATCH â€¦/toggle` | `AddRuleDialog` | â€” |
| `/tasks` | `Tasks` | `useTasks`, `useTaskStats`, `useTransitionTask`, `useProjects`, `useAgents`, `useSettings` | `GET /tasks`, `GET /tasks/stats`, `PATCH /tasks/:id/status` (Kanban) | — | — |
| `/queue` | `Queue` | `useQueue`, `useStopQueueEntry`, `useNow` | `GET /api/queue`, `POST /api/workflow-runs/:id/stop`, `POST /api/run/:id/stop` | — | Doc: [`pages/38-queue.md`](pages/38-queue.md). ADR 0033 — one slot, dispatch order, blocked reasons, scheduled agents. |
| `/tasks/new` | `TaskNew` | `useCreateTask`, `useProjects`, `useProjectRepos`, `useAgents`, `useSettings`, `useDraftGuard` | `GET /projects/:id/repos`, `POST /tasks` (`assignee_agent_id` on Submit — assigning queues the Task) | — | — |
| `/tasks/:id` | `TaskDetail` | `useTaskFull`, `useTransitionTask`, `useAssignTask`, `useUpdateTask`, `useDeleteTask`, `useCreateSubTask`, `useItemAgentRuns`, `useProjectLabels`, `useProjectRepos` (rail Repos row); rail `TaskRunPanel` (`useItemWorkflowRuns`, `useWorkflowRun`, `useStopWorkflowRun`, `useResumeWorkflowRun`) | `GET /tasks/:id/full`, `PATCH /tasks/:id` (incl. `repo_ids`) + `/{status,assign}` (assign queues a draft), `DELETE /tasks/:id`, `POST /tasks/:id/sub-tasks`, `GET /projects/:id/repos`, `GET /items/:id/workflow-runs`, `GET /workflow-runs/:id`, `POST /workflow-runs/:id/{stop,resume}` | `LinkPickerDialog`, `ConfirmDeleteModal`, inline Add sub-task form | — |
| `/sub-tasks/:id` | `SubTaskDetail` | `useSubTaskFull`, `useDeleteSubTask`, `useItemAgentRuns`, `useProjectLabels` | `GET /sub-tasks/:id/full`, `PATCH /sub-tasks/:id` + `/{status,assign}`, `DELETE /sub-tasks/:id`, `POST /tasks/:taskId/sub-tasks` (Clone) | `LinkPickerDialog` (tested_by picker restricted to the same Task), `ConfirmDeleteModal` | — |
| `/runs/:runId` | `RunDetail` (`pages/runs/`) | `useWorkflowRun`, `useStopWorkflowRun`, `useResumeWorkflowRun`, `useWorkflowRunDiff`, `useWorkflowRunFilePatch` | `GET /workflow-runs/:id`, `GET /workflow-runs/:id/{diff,diff/file}`, `POST /workflow-runs/:id/{stop,resume}` | — | One Task run (the `workflow_runs` record on the built-in `solo` workflow): steps, PRs, Changes per repo. Reached from the Task rail's `TaskRunPanel`. Doc: [`pages/37-run-detail.md`](pages/37-run-detail.md) |
| `/search` | `Search` | `useSearch`, `useAgentsWithPrompts`, `useProjects`, `useSettings`, `useProjectLabels` | `GET /search?q=&type=&project_id=&status=&updated=&labels=` (server-side Postgres FTS; `type` is `task` / `sub_task`) | — | "Create a Task / Sub-task" button only toasts (`Search.tsx:138`) |
| `/agents` | `Agents` | `useAgentsWithPrompts`, `useUpdateAgent`, `useAgentFavorites`, `useQuery(['runs','agents-page'])` | `GET /agents`, `GET /run?limit=500`, `GET /cli/availability`, `POST /agents`, `PATCH /agents/:id`, `DELETE /agents/:id`, `POST /agents/:id/duplicate` | `DuplicateAgentModal`, Add-Agent dialog | â€” |
| `/agents/:id` | `AgentDetail` (6 tabs: Overview, Prompt, **Tests**, **Performance**, Runs, Memory) | `useAgent`, `useUpdateAgent`, `useAgentMemory`, `useSetAgentMemory`, `useRegenerateAgentMemory`, `useAgentTests`, `useAgentTestRuns`, `useAgentCostEstimate`, `useQuery(['runs', agentId])`, plus per-tab hooks | `GET /agents/:id`, `PATCH /agents/:id`, `GET/PUT /agents/:id/memory`, `POST /agents/:id/memory/regenerate`, `GET/POST /agents/:id/tests`, `GET /agents/:id/cost-estimate`, `GET /agents/:id/performance`, `GET /agent-tests/:testId/batches`, `POST /agent-tests/:testId/run`, `DELETE /agent-tests/:testId`, `GET /agents/:id/runs`, `GET /cli/availability`, `POST /run` (Run now dialog) | `DuplicateAgentModal`, `RunNowDialog`, `GlyphPickerModal` | "Reassign queue", "Diff view for v{n}" (Prompt tab), formatting toolbar in Prompt tab |
| `/agents/performance` | `FleetPerformance` (window toggle 30/90 days in `?days=`) | `useFleetPerformance`, `useSearchParams`, `useNavigate` | `GET /agents/performance?days=` | — | — Doc: [`pages/36-fleet-performance.md`](pages/36-fleet-performance.md). Linked from the Agents header; no sidenav entry (Agents stays highlighted by prefix). Row click → `/agents/:id?tab=performance`. |
| `/agents/:id/runs/:runId` | `AgentRunDetail` | `useAgent`, `useAgentRun`, `useMutation(api.run.trigger)` | `GET /agents/:id`, `GET /run/:runId`, `POST /run` (Re-run with same inputs) | â€” | â€” |
| `/agents/marketplace` | `Marketplace` | `useQuery(['marketplace','list',q,category])`, `useNavigate`, `useToast` | `GET /api/marketplace/agents?q&category&limit` (via `api.marketplace.list`), `POST /api/marketplace/agents/:id/install` (bulk, via `runBulkInstall`), `GET /api/marketplace/agents/:id` + `GET /agents?view=summary` | `BulkInstallBar` (sticky) | Doc: [`pages/27-marketplace.md`](pages/27-marketplace.md). Bulk install reports the failing ids + server reason and STAYS on the page with them selected; only a clean sweep navigates to `/agents`. |
| `/agents/marketplace/:id` | `MarketplaceAgentDetail` | `useQuery(['marketplace','agent',id])`, `useQuery(['marketplace','list'])`, `useQueryClient`, `useToast`, `useNavigate` | `GET /marketplace/:id` (via `api.marketplace.get`), `GET /marketplace?limit=100`, `POST /marketplace/:id/install`, `GET /marketplace/:id/export.zip`, `GET /cli/availability`, `GET /agents?view=summary` | `AddFromMarketplaceModal` | Doc: [`pages/28-marketplace-detail.md`](pages/28-marketplace-detail.md) |
| `/agents/mcp-tools` | `McpTools` | `useQuery(['tool-catalog'])` | `GET /tool-catalog` (via `api.toolCatalog.get`) | â€” | Doc: [`pages/29-mcp-tools.md`](pages/29-mcp-tools.md) |
| `/analytics?window` | `Analytics` | `useAnalytics` (`hooks/useAnalytics.ts`) | `GET /analytics?tz&window` (via `api.analytics.get`) | — | Doc: [`pages/30-analytics.md`](pages/30-analytics.md) |
| `/notifications` | `Notifications` (2 tabs: external notification, InApp) | `useNotifications`, `useMarkAllRead`, `useResendNotification`, `useCancelNotification`, `useAgents`, `useNow` | `GET /notifications`, `POST /notifications/:id/{resend,cancel}`, `POST /notifications/mark-all-read`, `POST /settings/external-notification/test` | â€” | â€” |
| `/guardrails` | `Guardrails` | `useGuardrails`, `useCreateGuardrail`, `useUpdateGuardrail`, `useDeleteGuardrail`, `useSaveGuardrails`, `useNow` | `GET/POST/PATCH/DELETE /guardrails`, `POST /guardrails/save` | `GuardrailModal` | Discard button only clears session dirty counter, doesn't roll back edits |
| `/settings` | `Settings` (7 tabs: Profile, Environment, **Shared Secrets**, Model Registry, Notifications, **Jira**, Help & About) | `useSettings`, `useJiraConfig`, `useUpdateJiraConfig`, `useTestJira`, `useSyncJira`, `useUpdateProfile`, `useEnv`, `useUpdateEnv`, `useEnvironmentSecrets`, `useSaveEnvironmentSecrets`, `useRestartServer`, `useCliModels`, `useCreateCliModel`, `useRemoveCliModel`, `useUpdateExternalNotification`, `useUpdateNotifications`, `useCredentials`, `useProjects` | `GET /settings`, `PATCH /settings/profile`, `PATCH /settings/constitution`, `GET/PATCH /settings/env`, `GET/PUT /environment-secrets`, `POST /server/restart`, `GET/POST/DELETE /cli-models`, `PATCH /settings/external-notification`, `POST /settings/external-notification/test`, `PATCH /settings/notifications`, `GET/PUT /integrations/jira`, `POST /integrations/jira/{test,sync}`, `POST /settings/reset` | `ResetWorkspaceModal`, Restart Server confirm dialog | Chat-ID Detect button (`NotificationsTab.tsx:209-214`) shows "Detection not yet wired" toast |
| `/settings/credentials` | `Credentials` | `useCredentials`, `useMutation(deleteCredential)` | `GET/POST/PATCH/DELETE /credentials` | `CredentialModal` (3-view: kind picker â†’ form â†’ saved), Delete confirm dialog, `CredentialRowMenu` | SSH radio option disabled in the kind picker (`CredentialModal.tsx:415-432`); GitHub App is a working kind. *(corrected 2026-09-22 — "Check expiries", "Verify now" and the App password radio do not exist.)* |
| `/reminders` | `Reminders` | `useReminders`, `useCreateReminder`, `useCancelReminder`, `useToast` | `GET /reminders`, `POST /reminders`, `DELETE /reminders/:id` | `NewReminderModal`, cancel-confirm `Dialog` | â€” |
| `/scratch-pad` | `ScratchPad` | `useScratchPadList`, `useCreateScratchPad`, `useUpdateScratchPad`, `useDeleteScratchPad`, `useToast` | `GET /scratch-pad`, `POST /scratch-pad`, `PATCH /scratch-pad/:id`, `DELETE /scratch-pad/:id` | `ScratchPadEditor` (markdown editor modal) | â€” |
| `/terminal` | `Terminal` | `useCliSessions`, `useProjects`, `useCreateCliSession` (via dialog), `useToast` | `GET /cli/sessions`, `POST /cli/sessions` | `StartSessionDialog` | Multi-pane workspace entry (`/terminal/layout`); transcript history link on closed/errored cards (`/terminal/:id/history`) |
| `/terminal/standalone` | `TerminalStandalone` | `useCliSessions({standalone:true})`, `useCredentials`, `useCreateStandaloneCliSession` (via dialog), `useToast` | `GET /cli/sessions?standalone=true`, `POST /cli/sessions/standalone`, `GET /fs/{list,stat,join,home}` (via `FolderPicker`) | `StartStandaloneSessionDialog`, `ConfirmActionModal` (Stop, via `TerminalSessionControls`) | Declared BEFORE `/terminal/:id` in `App.tsx` or the param route swallows "standalone" as an id |
| `/terminal/layout` | `TerminalLayout` | `useCliSessions`, `useSearchParams`, `useToast`, `useNavigate` | `GET /cli/sessions`, `POST /cli/sessions` (via dialog), WS `/api/cli/sessions/:id/stream` (per pane) | `StartSessionDialog`, `StopSessionModal` (via `TerminalSessionControls`) | â€” |
| `/terminal/:id` | `TerminalSession` | `useCliSession(id)`, `usePauseCliSession`, `useResumeCliSession`, `useCliSessionDiff`, `useCliSessionFilePatch`, `useNavigate` (Pause/Resume/Stop now via `TerminalSessionControls`) | `GET /cli/sessions/:id`, `POST /cli/sessions/:id/{pause,resume,preflight-stop,stop}`, `GET /cli/sessions/:id/diff`, `GET /cli/sessions/:id/diff/file`, WS `/api/cli/sessions/:id/stream` | `StopSessionModal` (via `TerminalSessionControls`; diff panel lazy-loaded) | â€” |
| `/terminal/:id/history` | `TerminalHistory` | `useCliSession(id)`, `useCliSessionTranscript(id, status)` | `GET /cli/sessions/:id`, `GET /cli/sessions/:id/transcript` | â€” | â€” |

---

## Global app-shell GETs (every page)

These fire from `AppShell` / `Sidenav` / `Topbar` / `ReportBugLink` regardless of which page is mounted. They are intentionally NOT listed in the per-page "Main API endpoints" column because they're not page-specific. Captured here so the routes-map can be diffed against actual network captures without flagging them as drift.

| Endpoint | Origin | Caching |
|---|---|---|
| `GET /api/settings` | `useSettings()` â€” Topbar / Sidenav / RouteGuard / every page | `staleTime: Infinity`, `refetchOnMount: false`, `refetchOnWindowFocus: true` |
| `GET /api/settings/env` | `useEnv()` via `ReportBugLink` (sidenav footer) | `staleTime: Infinity`, `refetchOnMount: false` (post-2026-06-09 B2 fix) |
| `GET /api/counts` | `useSidenavCounts()` â€” Sidenav badges Counts ALL agents since 2026-09-12 (was `status='active'`, which disagreed with `/agents`). | `staleTime: Infinity`, `refetchOnMount: false`, SSE-invalidated |
| `GET /api/run?limit=500` | `useActiveRuns()` via `HeaderMascot` (Topbar) | `staleTime: 30_000`, `refetchOnMount: false` (post-2026-06-09 B2 fix), SSE-invalidated |

---

## Sidenav structure

Source: `packages/web/src/components/Sidenav.tsx:24-69`. Counts via `useSidenavCounts()` â†’ `GET /counts`.

```
WORKSPACE
  Dashboard           /              (no count)
  Scratch Pad         /scratch-pad
  Projects (N)        /projects
  Tasks (N)           /tasks
  Queue (N)           /queue
  Terminal            /terminal
  Standalone          /terminal/standalone
  Search              /search
  Analytics           /analytics

AGENTS
  Agents (N)         /agents
  Marketplace        /agents/marketplace
  MCP Tools          /agents/mcp-tools

ALERTS & ADMIN
  Notifications (N Â· unread dot)   /notifications
  Reminders           /reminders
  Guard-rails         /guardrails
  Settings            /settings
```

The shell's scrolling content area is the page's `main` landmark (`App.tsx`). Sidenav entries are real links (`<a href>`; Tab reaches them, Enter follows, a modified click opens a new tab — they were `Box onClick` rows the keyboard could not reach). The Topbar (`packages/web/src/components/Topbar.tsx`) holds the Notifications status indicator (popover: active provider, unread count, links to Notifications and Settings — see [17-notifications.md](pages/17-notifications.md)) and the shortcuts (`?`) icon that opens `ShortcutsDialog` (Cmd/Ctrl+?).

**Unsaved-draft guard.** `DraftGuardProvider` (`packages/web/src/hooks/useDraftGuard.tsx`) wraps `AppShell`. Sidenav rows, BottomNav tabs, MoreSheet rows and the `g`+`<key>` shortcuts navigate through `useConfirmLeave()`. When a mounted form has called `useDraftGuard(true)` (TaskNew, Task Detail's Add sub-task form), they open a **Discard draft?** dialog instead of navigating.

### Mobile behavior

Below the MUI `md` breakpoint (`<900px`, via `useIsMobile()` in `packages/web/src/hooks/useIsMobile.ts`):

- The inline Sidenav is replaced with a temporary `Drawer` (left-anchored, 240px wide). The drawer opens via a hamburger `IconButton` in the mobile `AppBar` and closes on backdrop tap or when a nav link is clicked (via `onNavigate` prop on `Sidenav`).
- The desktop `Topbar` is replaced by `MobileAppBar` (`packages/web/src/components/shell/MobileAppBar.tsx`), which renders: `â‰¡` hamburger Â· page title (set per-page via `useSetPageTitle()` from `PageTitleContext`) Â· optional trailing icon slot. 56pt tall, respects `env(safe-area-inset-top)`.
- A persistent `BottomNav` (`packages/web/src/components/shell/BottomNav.tsx`) renders 4 destinations: **Home** (`/`), **Projects** (`/projects`), **Tasks** (`/tasks`, also active on `/sub-tasks/:id`), **More**. The More tab opens a bottom `Drawer` (`MoreSheet`) listing every secondary sidenav destination so phone users can reach the same routes the desktop sidenav offers: Scratch Pad, Search, Analytics, Terminal, Standalone, Agents, Marketplace, MCP Tools, Notifications, Reminders, Guard-rails, Settings.
- The Shortcuts pill hides below `md` (no keyboard on touch devices).
- List pages (Projects, Tasks, Agents, Credentials) hide their top-right "+ New X" button on mobile and mount a `PageFab` instead, positioned above the bottom nav (`bottom: calc(80px + env(safe-area-inset-bottom))`).
- Tables (`WorkItemTable`, `TaskTable`) render as 2-line MUI list rows (`MobileWorkItemList` / `MobileTaskList`) below `md`.
- Filter-chip rows on Projects, Tasks, Agents scroll horizontally with no wrap on mobile.
- Dialog-based modals stay centered on every breakpoint and self-constrain via `PaperProps.sx` (`m: { xs: 2, sm: 4 }` + `maxHeight: 'calc(100% - 32px/64px)'`). `fullScreen={isMobile}` was removed across the modal surface (`ConfirmDeleteModal`, `Confirm*`, `RenameProjectModal`, `NewProjectModal`, `DeleteProjectModal`, `RecloneProjectModal`, `DuplicateAgentModal`, `AutoFetchScheduleModal`, `ProjectEnvSecretsModal`, `ResetWorkspaceModal`, `ShortcutsDialog`, the Handoffs inline delete confirm) because the edge-to-edge mobile sheet broke visual continuity with the parent UI and made small confirms look like separate pages.
- Sticky bottom action bars (Guardrails Save bar, TaskNew Draft/Submit footer) sit above the bottom nav via `bottom: calc(56px + env(safe-area-inset-bottom))`.
- Tabs on detail pages (Project / Agent / Settings / Notifications) use `variant="scrollable"` so they scroll horizontally on narrow viewports.

---

## Route guard

`packages/web/src/App.tsx:61-88`:

- If `!settings.onboarding_complete` AND `pathname !== '/onboarding'` â†’ redirect to `/onboarding`.
- If `settings.onboarding_complete` AND `pathname === '/onboarding'` â†’ redirect to `/`.

All other authenticated routes always render once onboarding is complete. There are no env-var feature flags hiding routes.
