import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { dropAndCreateDb, migrate, seed, startApi, waitForUrl } from '../global-setup.js';

// The core promise, for real: a Task assigned to Solo Engineer runs the real
// `claude` CLI in a worktree of a real GitHub repo, and Atlas commits, pushes
// and opens the PR with the real `gh`. Its own API (port 7101, MCP 7601) and
// DB (atlas_open_live), so neither the dev stack nor the e2e stack is touched.
//
// Costs real CLI credits and opens real PRs, so it runs only on request:
//   E2E_LIVE_PR=1 E2E_SKIP_SETUP=1 pnpm exec playwright test e2e/live/task-to-pr-live.spec.ts --project=chromium
// Needs `claude` signed in, `gh auth login` with repo scope, and LIVE_GH_REPO
// (default sspartorg/atlas-open-sandbox) on `main`. Teardown closes every PR
// it opened and deletes the branches.

test.skip(process.env['E2E_LIVE_PR'] !== '1', 'live PR spec: set E2E_LIVE_PR=1');
test.describe.configure({ mode: 'serial', timeout: 20 * 60_000 });

const REPO = process.env['LIVE_GH_REPO'] ?? 'sspartorg/atlas-open-sandbox';
const PORT = 7101;
const API = `http://127.0.0.1:${PORT}`;
const DB = 'atlas_open_live';
const LOGS = join(process.cwd(), 'e2e-logs');
const DATA = join(LOGS, 'live-data');
const ENV_FILE = join(LOGS, 'live.env');
const STAMP = Date.now().toString(36);

type Run = {
    id: string;
    status: 'running' | 'waiting_for_owner' | 'completed' | 'cancelled' | 'error';
    park_reason: string | null;
    pr_url: string | null;
    pr_urls: string[];
    steps?: Array<{ id: string; status: string }>;
};

let api: ChildProcess | null = null;
let projectId = '';
const prBranches = new Set<string>();

const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

function boot(): ChildProcess {
    return startApi({ port: PORT, mcpPort: 7601, dbName: DB, aiEnabled: true, dataDir: DATA, envFile: ENV_FILE, logName: 'api-live.log', live: true });
}

function kill(child: ChildProcess | null): void {
    if (!child?.pid) return;
    try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGTERM');
    } catch {
        // already gone
    }
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
    const res = await request.post(`${API}${path}`, { data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
    const res = await request.get(`${API}${path}`);
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
}

async function createTask(request: APIRequestContext, title: string, description: string): Promise<string> {
    const t = await post<{ id: string }>(request, '/api/tasks', { project_id: projectId, title, description, assignee_agent_id: 'agent-solo' });
    return t.id;
}

async function latestRun(request: APIRequestContext, taskId: string): Promise<Run | null> {
    const runs = await get<Run[]>(request, `/api/items/${taskId}/workflow-runs`);
    return runs[0] ? get<Run>(request, `/api/workflow-runs/${runs[0].id}`) : null;
}

/** Polls the Task's newest run until `done(run)`; fails fast on a status in `bad`. */
async function waitRun(request: APIRequestContext, taskId: string, done: (r: Run) => boolean, bad: Run['status'][] = [], timeout = 12 * 60_000): Promise<Run> {
    let last: Run | null = null;
    await expect
        .poll(
            async () => {
                last = await latestRun(request, taskId);
                if (last && bad.includes(last.status)) throw new Error(`run ${last.id} went ${last.status}: ${last.park_reason ?? ''}`);
                return !!last && done(last);
            },
            { timeout, intervals: [5_000] },
        )
        .toBe(true);
    return last!;
}

function rememberPrs(run: Run): void {
    for (const url of run.pr_urls) prBranches.add(gh('pr', 'view', url, '--json', 'headRefName', '--jq', '.headRefName'));
}

test.beforeAll(async ({ request }) => {
    test.setTimeout(5 * 60_000);
    rmSync(DATA, { recursive: true, force: true });
    mkdirSync(DATA, { recursive: true });
    writeFileSync(ENV_FILE, 'ATLAS_LOG_LEVEL=error\n');
    await dropAndCreateDb(DB);
    await migrate(DB);
    await seed(DB);
    api = boot();
    await waitForUrl(`${API}/api/health`, 'live api', 120_000);

    const cred = await post<{ id: string }>(request, '/api/credentials', { label: `live-${STAMP}`, token: gh('auth', 'token') });
    projectId = (await post<{ id: string }>(request, '/api/projects', { name: `Live ${STAMP}`, issue_key_prefix: 'LIV' })).id;
    const clone = await request.post(`${API}/api/projects/${projectId}/repos`, {
        data: { mode: 'clone', name: 'sandbox', repo_url: `https://github.com/${REPO}`, credential_id: cred.id, default_branch: 'main' },
    });
    expect(clone.status(), await clone.text()).toBe(202);
    await expect
        .poll(async () => (await get<Array<{ clone_status: string }>>(request, `/api/projects/${projectId}/repos`))[0]?.clone_status, { timeout: 120_000 })
        .toBe('ready');
});

test.afterAll(async () => {
    for (const branch of prBranches) {
        try {
            gh('pr', 'close', branch, '-R', REPO, '--delete-branch');
        } catch {
            // already closed or branch gone; nothing to clean
        }
    }
    // Parked or failed runs push their branch too, and a fresh DB numbers Tasks
    // from LIV-1 again, so leave no atlas/task/LIV-* branch behind.
    for (const ref of gh('api', `repos/${REPO}/git/matching-refs/heads/atlas/task/LIV-`, '--jq', '.[].ref').split('\n').filter(Boolean)) {
        gh('api', '-X', 'DELETE', `repos/${REPO}/git/${ref}`);
    }
    kill(api);
});

test('happy path: a Task becomes a PR with the agent’s change', async ({ request }) => {
    const line = `Hello from Atlas live test ${STAMP}`;
    const taskId = await createTask(request, `Append a greeting ${STAMP}`, `Append exactly this line to the end of README.md and change nothing else:\n\n${line}`);

    const run = await waitRun(request, taskId, (r) => r.status === 'completed', ['error', 'cancelled', 'waiting_for_owner']);
    rememberPrs(run);
    expect(run.pr_urls).toHaveLength(1);
    expect(run.pr_url).toContain(`github.com/${REPO}/pull/`);
    expect(gh('pr', 'diff', run.pr_url!)).toContain(line);
    expect((await get<{ status: string }>(request, `/api/tasks/${taskId}`)).status).toBe('in_review');
});

test('a question parks the run; the Owner’s reply resumes it to a PR', async ({ request }) => {
    const taskId = await createTask(
        request,
        `Add a note file ${STAMP}`,
        'Create a new markdown note file in the notes/ folder. You do not know the file name: before changing anything, ask the Owner which file name to use, and wait for the answer.',
    );
    const parked = await waitRun(request, taskId, (r) => r.status === 'waiting_for_owner', ['error', 'cancelled', 'completed']);
    expect(parked.park_reason ?? '').not.toBe('');

    const name = `live-${STAMP}.md`;
    await post(request, '/api/comments', { author: 'owner', issue_type: 'task', issue_id: taskId, body: `Use notes/${name}` });
    const run = await waitRun(request, taskId, (r) => r.status === 'completed', ['error', 'cancelled']);
    rememberPrs(run);
    expect(gh('pr', 'diff', run.pr_url!)).toContain(`notes/${name}`);
});

test('a Task that needs no change finishes without a raw delivery error', async ({ request }) => {
    const taskId = await createTask(request, `Confirm the README exists ${STAMP}`, 'Check that README.md exists. Do not create, edit or delete any file. Report that the check passed.');
    const run = await waitRun(request, taskId, (r) => r.status !== 'running', [], 10 * 60_000);
    rememberPrs(run);
    expect(run.status, run.park_reason ?? '').toBe('completed');
    expect(run.pr_urls).toHaveLength(0);
    expect((await get<{ status: string }>(request, `/api/tasks/${taskId}`)).status).toBe('done');
});

test('Stop ends a live run and it stays stopped', async ({ request }) => {
    const taskId = await createTask(request, `Write a long file ${STAMP}`, 'Create docs/long.md with a 2000-word essay about version control, written section by section.');
    const run = await waitRun(request, taskId, (r) => r.status === 'running' && (r.steps ?? []).some((s) => s.status === 'in_progress'), ['error', 'completed']);
    await post(request, `/api/workflow-runs/${run.id}/stop`, {});
    await waitRun(request, taskId, (r) => r.status === 'cancelled', ['completed', 'error'], 60_000);
    await new Promise((r) => setTimeout(r, 45_000)); // longer than the 30 s step-retry backoff
    const after = await latestRun(request, taskId);
    expect(after?.id).toBe(run.id);
    expect(after?.status).toBe('cancelled');
});

test('an API restart mid-run is recovered: the step errors, retries once, and the run finishes', async ({ request }) => {
    const line = `Recovered after restart ${STAMP}`;
    const taskId = await createTask(request, `Append after restart ${STAMP}`, `Append exactly this line to the end of README.md and change nothing else:\n\n${line}`);
    await waitRun(request, taskId, (r) => r.status === 'running' && (r.steps ?? []).some((s) => s.status === 'in_progress'), ['error', 'completed']);

    kill(api);
    api = boot();
    await waitForUrl(`${API}/api/health`, 'live api (restart)', 120_000);

    const run = await waitRun(request, taskId, (r) => r.status !== 'running', [], 15 * 60_000);
    // The orphan sweep errors the interrupted step; the automatic retry is a second step.
    const steps = run.steps ?? [];
    expect(steps.filter((s) => s.status === 'error')).toHaveLength(1);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    rememberPrs(run);
    expect(run.status, run.park_reason ?? '').toBe('completed');
    expect(gh('pr', 'diff', run.pr_url!)).toContain(line);
});

test('one agent at a time: a second Task waits until the first is done', async ({ request }) => {
    const a = await createTask(request, `Slot A ${STAMP}`, `Append the line "slot A ${STAMP}" to README.md and change nothing else.`);
    const b = await createTask(request, `Slot B ${STAMP}`, `Append the line "slot B ${STAMP}" to README.md and change nothing else.`);
    let overlap = false;
    await expect
        .poll(
            async () => {
                const [ra, rb] = [await latestRun(request, a), await latestRun(request, b)];
                if (ra?.status === 'running' && rb?.status === 'running') overlap = true;
                return ra?.status === 'completed' && rb !== null && rb.status !== 'running';
            },
            { timeout: 15 * 60_000, intervals: [3_000] },
        )
        .toBe(true);
    for (const id of [a, b]) {
        const r = await latestRun(request, id);
        if (r) rememberPrs(r);
    }
    expect(overlap).toBe(false);
});

// The Jira bridge, for real: a throwaway issue (JQL `key = <it>`, so nothing
// else is touched) imports as a Task for Solo Engineer, runs to a PR, and the
// next sync comments on the issue. Needs LIVE_JIRA_SITE / _EMAIL / _TOKEN and
// LIVE_JIRA_PROJECT (default ATL); the issue is deleted afterwards.
test.describe('Jira bridge', () => {
    const site = process.env['LIVE_JIRA_SITE'] ?? '';
    const email = process.env['LIVE_JIRA_EMAIL'] ?? '';
    const token = process.env['LIVE_JIRA_TOKEN'] ?? '';
    test.skip(!site || !email || !token, 'set LIVE_JIRA_SITE, LIVE_JIRA_EMAIL and LIVE_JIRA_TOKEN');
    const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    const jira = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${site}${path}`, { method, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : null });
        const text = await res.text();
        expect(res.ok, `${method} ${path}: ${text}`).toBe(true);
        return (text ? JSON.parse(text) : null) as Record<string, any>;
    };
    let issueKey = '';
    test.afterAll(async () => {
        if (issueKey) await jira('DELETE', `/rest/api/3/issue/${issueKey}`);
    });

    test('an imported Jira issue runs to a PR, and the issue hears about it', async ({ request }) => {
        const line = `Hello from Jira ${STAMP}`;
        const types = await jira('GET', `/rest/api/3/issue/createmeta/${process.env['LIVE_JIRA_PROJECT'] ?? 'ATL'}/issuetypes`);
        const taskType = (types['issueTypes'] ?? types['values']).find((t: { name: string }) => t.name === 'Task');
        issueKey = (
            await jira('POST', '/rest/api/3/issue', {
                fields: {
                    project: { key: process.env['LIVE_JIRA_PROJECT'] ?? 'ATL' },
                    issuetype: { id: taskType.id },
                    summary: `Atlas live test ${STAMP}`,
                    labels: ['atlas-live-test'],
                    description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Append exactly this line to the end of README.md and change nothing else: ${line}` }] }] },
                },
            })
        )['key'];

        const put = await request.put(`${API}/api/integrations/jira`, { data: { enabled: true, site_url: site, email, api_token: token } });
        expect(put.ok(), await put.text()).toBe(true);
        const repoId = (await get<Array<{ id: string }>>(request, `/api/projects/${projectId}/repos`))[0]!.id;
        await post(request, `/api/projects/${projectId}/jira-sources`, { jql: `key = ${issueKey}`, agent_id: 'agent-solo', repo_ids: [repoId] });
        await post(request, '/api/integrations/jira/sync', {});

        const tasks = await get<Array<{ id: string; title: string }>>(request, `/api/tasks?project_id=${projectId}`);
        const task = tasks.find((t) => t.title.includes(STAMP) && t.title.includes('Atlas live test'));
        expect(task, `imported Task for ${issueKey}`).toBeTruthy();

        const run = await waitRun(request, task!.id, (r) => r.status === 'completed', ['error', 'cancelled', 'waiting_for_owner']);
        rememberPrs(run);
        expect(gh('pr', 'diff', run.pr_url!)).toContain(line);

        await post(request, '/api/integrations/jira/sync', {});
        const issue = await jira('GET', `/rest/api/3/issue/${issueKey}?fields=comment`);
        expect(issue['fields'].comment.comments.length, 'Atlas commented on the issue').toBeGreaterThan(0);
    });
});
