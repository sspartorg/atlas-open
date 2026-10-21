import type { Page } from '@playwright/test';

// The heavy routes the perf + visual harness walks, on the `atlas_perf` seed
// (`e2e/fixtures/perf-seed.ts`). Ids are the seed's fixed ids.

export interface PerfRoute {
    name: string;
    path: string;
    /** Local storage to set before the page boots (view mode, page size…). */
    storage?: Record<string, string>;
    /** Run after the page settles and before measuring scroll. */
    prepare?: (page: Page) => Promise<void>;
}

const showAllRows = async (page: Page) => {
    const rows = page.locator('label:has-text("Rows") select').first();
    if (await rows.count()) await rows.selectOption('all');
};

export const ROUTES: PerfRoute[] = [
    { name: 'dashboard', path: '/' },
    { name: 'tasks-table', path: '/tasks', storage: { 'atlas.viewMode.tasks': 'table' } },
    { name: 'tasks-table-all', path: '/tasks', storage: { 'atlas.viewMode.tasks': 'table' }, prepare: showAllRows },
    { name: 'tasks-kanban', path: '/tasks', storage: { 'atlas.viewMode.tasks': 'kanban' } },
    { name: 'task-hot', path: '/tasks/PFA-1' },
    { name: 'sub-task', path: '/sub-tasks/PFA-2' },
    { name: 'task-new', path: '/tasks/new' },
    { name: 'projects', path: '/projects' },
    { name: 'project-overview', path: '/projects/perf-alpha' },
    { name: 'project-tasks', path: '/projects/perf-alpha?tab=tasks' },
    { name: 'project-history', path: '/projects/perf-alpha?tab=history' },
    { name: 'project-guardrails', path: '/projects/perf-alpha?tab=guardrails' },
    { name: 'project-repos', path: '/projects/perf-alpha?tab=repos' },
    { name: 'project-jira', path: '/projects/perf-alpha?tab=jira' },
    { name: 'project-setup', path: '/projects/perf-alpha?tab=setup' },
    { name: 'agents', path: '/agents' },
    { name: 'agent-overview', path: '/agents/agent-solo' },
    { name: 'agent-tests', path: '/agents/agent-solo?tab=tests' },
    { name: 'agent-tests-pending', path: '/agents/agent-ai-news?tab=tests' },
    { name: 'agent-performance', path: '/agents/agent-solo?tab=performance' },
    { name: 'agent-runs', path: '/agents/agent-solo?tab=runs' },
    { name: 'run-big-log', path: '/agents/agent-ai-news/runs/perf-run-0' },
    { name: 'notifications', path: '/notifications' },
    { name: 'analytics', path: '/analytics' },
];
