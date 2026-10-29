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
// Second repo for the multi-repo Task (its own README only).
const REPO2 = process.env['LIVE_GH_REPO2'] ?? 'sspartorg/atlas-open-sandbox-2';
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
let credId = '';
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

async function createTask(request: APIRequestContext, title: string, description: string, agent = 'agent-solo'): Promise<string> {
    const t = await post<{ id: string }>(request, '/api/tasks', { project_id: projectId, title, description, assignee_agent_id: agent });
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
    await seed(DB, join(DATA, 'fixtures')); // own dir: a `pnpm e2e` beside this one holds the default open
    api = boot();
    await waitForUrl(`${API}/api/health`, 'live api', 120_000);

    const cred = await post<{ id: string }>(request, '/api/credentials', { label: `live-${STAMP}`, token: gh('auth', 'token') });
    credId = cred.id;
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
    for (const repo of [REPO, REPO2]) {
        for (const ref of gh('api', `repos/${repo}/git/matching-refs/heads/atlas/task/LIV-`, '--jq', '.[].ref').split('\n').filter(Boolean)) {
            gh('api', '-X', 'DELETE', `repos/${repo}/git/${ref}`);
        }
    }
    kill(api);
});

// X1: a stored secret never comes back from a list or get.
test('no stored token appears in a credential or Jira settings response', async ({ request }) => {
    const token = gh('auth', 'token');
    for (const path of ['/api/credentials', `/api/credentials/${credId}`, '/api/integrations/jira', '/api/settings']) {
        const body = await (await request.get(`${API}${path}`)).text();
        expect(body, path).not.toContain(token);
        if (process.env['LIVE_JIRA_TOKEN']) expect(body, path).not.toContain(process.env['LIVE_JIRA_TOKEN']);
    }
});

// The README's "an MCP server so your AI CLI can drive Atlas": the Owner's own
// `claude`, given only this instance's MCP, creates a Task.
test('the Owner’s claude CLI creates a Task through the Atlas MCP', async ({ request }) => {
    const cfg = join(DATA, 'owner-mcp.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { atlas: { type: 'http', url: 'http://127.0.0.1:7601/mcp' } } }));
    const title = `MCP owner ${STAMP}`;
    execFileSync(
        'claude',
        ['-p', '--model', 'claude-haiku-5-5', '--strict-mcp-config', '--mcp-config', cfg, '--allowedTools', 'mcp__atlas__create_item'],
        { shell: process.platform === 'win32', input: `Use the atlas create_item tool once: issue_type "task", payload { "project_id": "${projectId}", "title": "${title}" }. Then reply "done".`, encoding: 'utf8', timeout: 5 * 60_000 },
    );
    const tasks = await get<Array<{ title: string; status: string }>>(request, `/api/tasks?project_id=${projectId}`);
    expect(tasks.find((t) => t.title === title)).toMatchObject({ status: 'draft' });
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

// README: "one PR per repo it touched". Two repos on the project, a change
// in only the second: exactly one PR, on that repo.
test('a multi-repo Task opens a PR only on the repo it changed', async ({ request }) => {
    const add = await request.post(`${API}/api/projects/${projectId}/repos`, {
        data: { mode: 'clone', name: 'sandbox2', repo_url: `https://github.com/${REPO2}`, credential_id: credId, default_branch: 'main' },
    });
    expect(add.status(), await add.text()).toBe(202);
    const repo2 = async () =>
        (await get<Array<{ id: string; name: string; clone_status: string }>>(request, `/api/projects/${projectId}/repos`)).find((r) => r.name === 'sandbox2');
    await expect.poll(async () => (await repo2())?.clone_status, { timeout: 120_000 }).toBe('ready');
    try {
        const line = `Multi-repo line ${STAMP}`;
        // With two repos the Task names the ones it works on: both.
        const repoIds = (await get<Array<{ id: string }>>(request, `/api/projects/${projectId}/repos`)).map((r) => r.id);
        const { id: taskId } = await post<{ id: string }>(request, '/api/tasks', {
            project_id: projectId,
            title: `Append to the sandbox2 README ${STAMP}`,
            description: `This Task has two repos checked out side by side. Append exactly this line to the end of README.md in the sandbox2 repo only, and change nothing in the other repo:\n\n${line}`,
            assignee_agent_id: 'agent-solo',
            repo_ids: repoIds,
        });
        const run = await waitRun(request, taskId, (r) => r.status === 'completed', ['error', 'cancelled', 'waiting_for_owner']);
        rememberPrs(run);
        expect(run.pr_urls).toHaveLength(1);
        expect(run.pr_urls[0]).toContain(`github.com/${REPO2}/pull/`);
        expect(gh('pr', 'diff', run.pr_urls[0]!)).toContain(line);
    } finally {
        await request.delete(`${API}/api/projects/${projectId}/repos/${(await repo2())!.id}`);
    }
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

// The everyday failure: the token expired. The first fetch is turned away, the
// run parks saying which credential to fix, and after a good token Resume delivers.
test('an expired token parks saying what to fix, and Resume after a token fix delivers', async ({ request }) => {
    const line = `Delivered after a token fix ${STAMP}`;
    const patch = (token: string) => request.patch(`${API}/api/credentials/${credId}`, { data: { token } });
    expect((await patch('ghp_expired0000000000000000000000000000')).ok()).toBe(true);
    try {
        const taskId = await createTask(request, `Append after token fix ${STAMP}`, `Append exactly this line to the end of README.md and change nothing else:

${line}`);
        const parked = await waitRun(request, taskId, (r) => r.status === 'waiting_for_owner', ['error', 'cancelled', 'completed']);
        expect(parked.park_reason).toMatch(/^GitHub rejected this repo's credential.*Settings → Credentials, then Resume\./);

        expect((await patch(gh('auth', 'token'))).ok()).toBe(true);
        await post(request, `/api/workflow-runs/${parked.id}/resume`, {});
        const run = await waitRun(request, taskId, (r) => r.status === 'completed', ['error', 'cancelled']);
        rememberPrs(run);
        expect(gh('pr', 'diff', run.pr_url!)).toContain(line);
    } finally {
        await patch(gh('auth', 'token'));
    }
});

// A reset DB numbers Tasks from 1 again, and the remote may still hold
// atlas/task/<key> from the earlier install. The new Task must still deliver.
test('a branch left on GitHub by an earlier install does not block delivery', async ({ request }) => {
    const key = `LIV-${(await get<unknown[]>(request, `/api/tasks?project_id=${projectId}`)).length + 1}`;
    const base = gh('api', `repos/${REPO}/commits/main`, '--jq', '.parents[0].sha');
    gh('api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/atlas/task/${key}`, '-f', `sha=${base}`);
    const line = `Delivered over a stale branch ${STAMP}`;
    const taskId = await createTask(request, `Append over stale branch ${STAMP}`, `Append exactly this line to the end of README.md and change nothing else:

${line}`);
    expect(taskId).toBe(key);
    const run = await waitRun(request, taskId, (r) => r.status !== 'running', [], 12 * 60_000);
    rememberPrs(run);
    expect(run.status, run.park_reason ?? '').toBe('completed');
    expect(gh('pr', 'diff', run.pr_url!)).toContain(line);
});

// Postgres restarts under a running API (Docker Desktop update, a reboot of
// the container): the API keeps serving once it is back, without a restart.
test('the API recovers by itself after Postgres restarts', async ({ request }) => {
    execFileSync('docker', ['restart', 'atlas-open-postgres'], { stdio: 'ignore', timeout: 120_000 });
    await expect
        .poll(async () => (await request.get(`${API}/api/tasks?project_id=${projectId}`)).status(), { timeout: 90_000, intervals: [2_000] })
        .toBe(200);
    // Unassigned, so it stays a draft and starts no agent.
    const { id } = await post<{ id: string }>(request, '/api/tasks', { project_id: projectId, title: `After a DB restart ${STAMP}` });
    expect((await get<{ status: string }>(request, `/api/tasks/${id}`)).status).toBe('draft');
});

// The Terminal: a real `claude` PTY session on the repo writes a file, and
// Stop commits it, pushes and opens the PR.
test('a Terminal session with the real claude CLI ends in a PR', async ({ request }) => {
    const file = `hello-${STAMP}.txt`;
    const session = await post<{ id: string }>(request, '/api/cli/sessions', {
        project_id: projectId,
        title: `Terminal ${STAMP}`,
        model: 'claude-haiku-5-5',
        initial_prompt: `Create a file named ${file} at the repo root containing exactly: hi. Do nothing else.`,
    });
    await expect.poll(async () => (await get<{ status: string }>(request, `/api/cli/sessions/${session.id}`)).status, { timeout: 60_000 }).toBe('active');
    // Watch the terminal: the new worktree opens on the CLI's
    // folder-trust dialog, which Atlas answers in its own worktrees.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/cli/sessions/${session.id}/stream`);
    ws.binaryType = 'arraybuffer';
    let screen = '';
    let answered = false;
    ws.addEventListener('message', (e) => {
        screen += typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8');
        // The CLI moves the cursor between words instead of printing spaces.
        const text = screen.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ');
        // Atlas answers it in its own worktrees; this only records that it was shown.
        if (/one you trust\?|trust the files in this folder/i.test(text)) answered = true;
    });
    try {
        await expect
            .poll(async () => JSON.stringify(await get(request, `/api/cli/sessions/${session.id}/diff`)), { timeout: 5 * 60_000, intervals: [5_000] })
            .toContain(file);
    } finally {
        // What the Owner would have seen, for when it does not get there.
        writeFileSync(join(LOGS, 'live-terminal-screen.txt'), `answered=${answered}
${screen.replace(/\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')}`);
    }

    ws.close();
    test.info().annotations.push({ type: 'trust dialog', description: answered ? 'shown and answered' : 'not shown' });
    const stop = await post<Record<string, unknown>>(request, `/api/cli/sessions/${session.id}/stop`, { files_to_stage: [file], commit_message: `Terminal ${STAMP}` });
    const prUrl = JSON.stringify(stop).match(new RegExp(`https://github\\.com/${REPO}/pull/\\d+`))?.[0];
    expect(prUrl, JSON.stringify(stop)).toBeTruthy();
    prBranches.add(gh('pr', 'view', prUrl!, '--json', 'headRefName', '--jq', '.headRefName'));
    expect(gh('pr', 'diff', prUrl!)).toContain(file);
    expect((await get<{ status: string }>(request, `/api/cli/sessions/${session.id}`)).status).toBe('closed');
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

// Every marketplace agent once, on demand (no item): it installs, runs to the
// end, and the agents that write through `mcp__atlas__*` reach THIS instance —
// itemless runs get its `atlas` even when ~/.claude.json names another.
// Jira to Epic ships with unfilled placeholders and must refuse to import.
// Opt-in on top of E2E_LIVE_PR (AI Readiness runs Opus): LIVE_MARKETPLACE=1.
test.describe('marketplace agents', () => {
    test.skip(process.env['LIVE_MARKETPLACE'] !== '1', 'set LIVE_MARKETPLACE=1');
    type AgentRun = { id: string; status: string; output_text: string | null; outcome_kind: string | null; total_cost_usd: number | null };

    for (const slug of ['agent-ai-news', 'agent-market-research', 'agent-regulations', 'agent-knowledge-base', 'agent-ai-readiness', 'agent-jira-to-epic']) {
        test(`${slug} installs and runs to the end`, async ({ request }) => {
            const res = await request.post(`${API}/api/marketplace/agents/${slug}/install`, { data: {} });
            expect([200, 201, 409], await res.text()).toContain(res.status());
            const before = (await get<Array<{ id: string }>>(request, `/api/tasks?project_id=${projectId}`)).length;

            const { runId } = await post<{ runId: string }>(request, '/api/run', { agent_id: slug, project_id: projectId });
            let run: AgentRun | null = null;
            await expect
                .poll(async () => (run = await get<AgentRun>(request, `/api/run/${runId}`)).status, { timeout: 25 * 60_000, intervals: [10_000] })
                .toMatch(/^(completed|error|cancelled)$/);
            const out = run!.output_text ?? '';
            const created = (await get<Array<{ id: string }>>(request, `/api/tasks?project_id=${projectId}`)).length - before;
            test.info().annotations.push({ type: 'result', description: `${run!.status} · outcome ${run!.outcome_kind} · $${run!.total_cost_usd ?? '?'} · ${created} task(s)` });

            expect(run!.status, out.slice(-1500)).toBe('completed');
            expect(out).not.toMatch(/ECONNREFUSED|Failed to connect/);
            if (slug === 'agent-jira-to-epic') expect(created, 'an unconfigured importer imports nothing').toBe(0);
        });
    }

    // These two read the repo, so they work through a Task (an on-demand run
    // gets a throwaway folder with no source).
    for (const [slug, path] of [['agent-knowledge-base', 'skills/'], ['agent-ai-readiness', 'AGENTS.md']] as const) {
        test(`${slug} turns a Task into a PR`, async ({ request }) => {
            const res = await request.post(`${API}/api/marketplace/agents/${slug}/install`, { data: {} });
            expect([200, 201, 409], await res.text()).toContain(res.status());
            const taskId = await createTask(request, `${slug} pass ${STAMP}`, 'Do your job for this repository.', slug);
            const run = await waitRun(request, taskId, (r) => r.status !== 'running', [], 25 * 60_000);
            rememberPrs(run);
            expect(run.status, run.park_reason ?? '').toBe('completed');
            expect(gh('pr', 'diff', run.pr_url!)).toContain(path);
        });
    }
});
