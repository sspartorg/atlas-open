import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExternalLinksModule from './external-links.js';
import type * as WorktreeOrchestratorModule from './worktree-orchestrator.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunOutcomeKind, RunStatus } from '@atlas/shared';

// The engine is exercised against the real DB; only the parts that would
// spawn a CLI or touch git are replaced. `spawnAgentRun` just records a live
// step row, the way the real runner's INSERT does.
const spawned: Array<{ agentId: string; nodeId: string; runId: string; skipSetup: boolean }> = [];
vi.mock('./agent-runner.js', () => ({
    spawnAgentRun: vi.fn(async (opts: { agentId: string; issueId?: string | null; existingRunId?: string; workflowRun?: { id: string; nodeId: string; skipSetup?: boolean; retryOf?: string } | null }) => {
        const { testDb } = await import('../../tests/_pg-db.js');
        // An itemless run from the queue: the real runner UPDATEs the waiting row.
        if (opts.existingRunId) {
            await testDb.updateTable('agent_runs').set({ status: 'in_progress', prompt_snapshot: 'p' }).where('id', '=', opts.existingRunId).execute();
            spawned.push({ agentId: opts.agentId, nodeId: '', runId: opts.existingRunId, skipSetup: false });
            return opts.existingRunId;
        }
        const id = randomUUID();
        await testDb
            .insertInto('agent_runs')
            .values({
                id,
                agent_id: opts.agentId,
                item_id: opts.issueId ?? null,
                status: 'in_progress',
                workflow_run_id: opts.workflowRun?.id ?? null,
                node_id: opts.workflowRun?.nodeId ?? null,
                parent_run_id: opts.workflowRun?.retryOf ?? null,
                started_at: new Date().toISOString(),
            })
            .execute();
        spawned.push({ agentId: opts.agentId, nodeId: opts.workflowRun?.nodeId ?? '', runId: id, skipSetup: opts.workflowRun?.skipSetup ?? false });
        return id;
    }),
    cancelRun: vi.fn(async () => ({ cancelled: false, pidKilled: null })),
}));

const git = vi.hoisted(() => ({
    ensureWorktree: vi.fn(async () => ({ path: '/tmp/atlas-run-test', branch: 'atlas/task/x', freshlyCreated: true })),
    pushWorktree: vi.fn(async () => ({ pushed: true, alreadyUpToDate: false })),
    openPullRequest: vi.fn(async () => ({ opened: true, url: 'https://github.com/o/r/pull/7', alreadyExists: false })),
    cleanupWorktreeAfterPush: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true, dbCleared: false, warnings: [] })),
}));
vi.mock('./worktree-orchestrator.js', async (importOriginal) => ({
    ...(await importOriginal<typeof WorktreeOrchestratorModule>()),
    ...git,
}));
vi.mock('./external-links.js', async (importOriginal) => ({
    ...(await importOriginal<typeof ExternalLinksModule>()),
    fetchGithubPrTitle: vi.fn(async () => null),
}));
vi.mock('../routes/events.js', () => ({ eventsRoutes: async () => undefined, broadcastSSE: vi.fn() }));
const sendExternal = vi.hoisted(() => vi.fn(async (_id: number, _m: string, _k?: string) => {}));
vi.mock('./external-notifications.js', () => ({ sendExternalForNotification: sendExternal }));

import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent, insertItem, insertProject } from '../../tests/_items.js';
import {
    cancelWorkflowRun,
    countBusySlots,
    kickWorkflowDispatch,
    listDispatchQueue,
    onStepFinished,
    reconcileWorkflowRuns,
    resumeWorkflowRun,
    retryStep,
    startTaskRun,
    STEP_RETRY_BACKOFF_MS,
    tickWorkflowDispatch,
    WorkflowStartError,
} from './workflow-engine.js';
import { commentsService } from './comments.js';
import { tasksService } from './tasks.js';
import { queueAgentRun } from './agent-schedules.js';
import { computeWorktreePath } from './worktree-orchestrator.js';

/** Finishes the most recently spawned step the way the runner would. */
async function finishStep(status: RunStatus, outcome: RunOutcomeKind | null = 'done', reason?: string): Promise<void> {
    const step = spawned.at(-1);
    if (!step) throw new Error('no step spawned');
    await testDb
        .updateTable('agent_runs')
        .set({ status, completed_at: new Date().toISOString(), outcome_kind: outcome, outcome_reason: reason ?? null })
        .where('id', '=', step.runId)
        .execute();
    await onStepFinished(step.runId);
}

const runOf = (id: string) => testDb.selectFrom('workflow_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const parkKind = async (id: string) =>
    (
        await testDb
            .selectFrom('workflow_run_events')
            .select('park_kind')
            .where('workflow_run_id', '=', id)
            .where('kind', '=', 'parked')
            .orderBy('created_at', 'desc')
            .executeTakeFirst()
    )?.park_kind;
const parkComments = async () => (await commentsService.list('task', 'ATL-2')).filter((c) => c.body.includes('is waiting for you'));
const itemOf = (id: string) => testDb.selectFrom('items').select(['status', 'assignee_agent_id', 'pr_url']).where('id', '=', id).executeTakeFirstOrThrow();

beforeEach(async () => {
    spawned.length = 0;
    vi.clearAllMocks();
    await truncateAll();
    await insertProject('p1', 'ATL', { git_path: '/tmp/repo' });
    await insertAgent({ id: 'agent-solo', status: 'active' });
    await insertItem({ id: 'ATL-2', type: 'task', project_id: 'p1', title: 'Task', status: 'ready', assignee_agent_id: 'agent-solo' });
});

afterAll(async () => {
    await closeTestDb();
});

describe('task run — happy path', () => {
    it('runs the assigned agent once in its own worktree and delivers one PR', async () => {
        const runId = await startTaskRun('ATL-2');

        expect(git.ensureWorktree).toHaveBeenCalledTimes(1);
        expect(spawned).toEqual([expect.objectContaining({ agentId: 'agent-solo', nodeId: 'agent' })]);
        expect(await runOf(runId)).toMatchObject({ workflow_id: 'solo', branch: 'atlas/task/ATL-2', status: 'running' });
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'in_progress', assignee_agent_id: 'agent-solo' });

        await finishStep('completed', 'done');
        expect(git.pushWorktree).toHaveBeenCalledTimes(1);
        expect(git.openPullRequest).toHaveBeenCalledTimes(1);
        expect(git.cleanupWorktreeAfterPush).toHaveBeenCalledTimes(1);
        expect(await runOf(runId)).toMatchObject({ status: 'completed', pr_url: 'https://github.com/o/r/pull/7' });
        // The assignee stays: it is the Task's agent, not "who is busy right now".
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'in_review', assignee_agent_id: 'agent-solo', pr_url: 'https://github.com/o/r/pull/7' });
        expect(spawned).toHaveLength(1);
    });

    it('re-creates the solo run record when it has been wiped', async () => {
        await testDb.deleteFrom('workflows').execute();
        const runId = await startTaskRun('ATL-2');
        expect(await runOf(runId)).toMatchObject({ workflow_id: 'solo' });
    });

    it('parks at End when delivery fails and retries delivery on resume', async () => {
        git.pushWorktree.mockResolvedValueOnce({ pushed: false, alreadyUpToDate: false, error: 'no credential' } as never);
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'done');

        expect(await runOf(runId)).toMatchObject({
            status: 'waiting_for_owner',
            parked_node_id: 'end',
            park_reason: 'Push failed: no credential. Resume the run to retry delivery.',
        });
        expect(await parkKind(runId)).toBe('delivery_failed');
        expect(git.cleanupWorktreeAfterPush).not.toHaveBeenCalled();

        await resumeWorkflowRun(runId);
        expect(git.pushWorktree).toHaveBeenCalledTimes(2);
        expect(await runOf(runId)).toMatchObject({ status: 'completed' });
        expect(spawned).toHaveLength(1);
    });

    it('refuses a second live run, an unassigned Task and a Task with no repos', async () => {
        await startTaskRun('ATL-2');
        await expect(startTaskRun('ATL-2')).rejects.toBeInstanceOf(WorkflowStartError);

        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'No agent', status: 'ready' });
        await expect(startTaskRun('ATL-3')).rejects.toThrow('Assign an agent');

        await insertItem({ id: 'ATL-4', type: 'task', project_id: 'p1', title: 'No repos', status: 'ready', assignee_agent_id: 'agent-solo' });
        await testDb.updateTable('items').set({ repo_ids: JSON.stringify([]) as never }).where('id', '=', 'ATL-4').execute();
        await expect(startTaskRun('ATL-4')).rejects.toThrow('no repos');
    });

    it('ignores a stale report for a run that already finished', async () => {
        await startTaskRun('ATL-2');
        const step = spawned[0]!; // reason: startTaskRun spawned the agent above
        await finishStep('completed', 'done');
        await onStepFinished(step.runId);
        expect(git.pushWorktree).toHaveBeenCalledTimes(1);
    });
});

describe('task run — parking', () => {
    it('treats a missing outcome block as a question for the Owner', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', null);
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner', parked_node_id: 'agent', park_reason: 'agent_did_not_signal_outcome' });
        expect(await parkKind(runId)).toBe('no_outcome');
        expect(await parkComments()).toHaveLength(1);
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'waiting_for_info', assignee_agent_id: 'agent-solo' });
    });

    it('re-runs the agent on a refreshed branch when the Owner replies on the Task', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'asked_question', 'Which API version?');
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner', parked_node_id: 'agent' });
        // The step's completion comment already carries the question.
        expect(await parkComments()).toHaveLength(0);

        await commentsService.create({ author: 'owner', issue_type: 'task', issue_id: 'ATL-2', body: 'Use v2.' });
        await vi.waitFor(() => expect(spawned).toHaveLength(2));
        await vi.waitFor(async () => expect(await runOf(runId)).toMatchObject({ status: 'running', current_node_id: 'agent' }));
        expect(git.ensureWorktree).toHaveBeenCalledTimes(2);
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'in_progress' });
    });

    it('parks a rejection with the Owner instead of looping', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'rejected', 'cannot be done as written');
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner', parked_node_id: 'agent' });
        expect(await parkKind(runId)).toBe('rejected');
        expect(spawned).toHaveLength(1);
        expect(git.openPullRequest).not.toHaveBeenCalled();
    });

    it('parks a done that left a required checklist row unticked', async () => {
        await testDb.insertInto('agent_checklists').values({ agent_id: 'agent-solo', label: 'Tests pass', sort_order: 0, required: true } as never).execute();
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'done');
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner' });
        expect(await parkKind(runId)).toBe('checklist_failed');
    });

    it('parks instead of continuing when the resumed branch cannot be refreshed onto main', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'asked_question', 'Which API version?');
        git.ensureWorktree.mockRejectedValueOnce(new Error('rebase conflict on abc1234'));

        await resumeWorkflowRun(runId);
        expect(spawned).toHaveLength(1);
        expect(await runOf(runId)).toMatchObject({
            status: 'waiting_for_owner',
            park_reason: 'Could not refresh the worktree onto the latest default branch: rebase conflict on abc1234',
        });
        expect(await parkKind(runId)).toBe('setup_failed');
    });

    it('parks when setup fails', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('setup_failed', null);
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner', setup_done: false });
        expect(await parkKind(runId)).toBe('setup_failed');
    });

    it('parks when the assigned agent is inactive', async () => {
        await testDb.updateTable('agents').set({ status: 'inactive' }).where('id', '=', 'agent-solo').execute();
        const runId = await startTaskRun('ATL-2');
        expect(spawned).toHaveLength(0);
        expect(await parkKind(runId)).toBe('missing_agent');
    });
});

describe('task run — a crashed agent is retried once', () => {
    const crash = async (output: string): Promise<string> => {
        const step = spawned.at(-1)!; // reason: every caller spawned a step first
        await testDb.updateTable('agent_runs').set({ output_text: output }).where('id', '=', step.runId).execute();
        await finishStep('error', null);
        return step.runId;
    };
    const RESTART = '{"type":"system"}\n[ERROR] API restarted before run completed';

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits out the backoff, retries quietly, and delivers when the retry succeeds', async () => {
        const runId = await startTaskRun('ATL-2');
        const crashed = await crash(RESTART);
        expect(await runOf(runId)).toMatchObject({ status: 'running', park_reason: null });
        expect(await parkComments()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(STEP_RETRY_BACKOFF_MS);
        await vi.waitFor(() => expect(spawned).toHaveLength(2));
        const retry = await testDb.selectFrom('agent_runs').select('parent_run_id').where('id', '=', spawned[1]!.runId).executeTakeFirstOrThrow(); // reason: length asserted above
        expect(retry.parent_run_id).toBe(crashed);

        await finishStep('completed', 'done');
        expect(await runOf(runId)).toMatchObject({ status: 'completed' });
    });

    it('parks, saying it retried, when the retry crashes too', async () => {
        const runId = await startTaskRun('ATL-2');
        await crash(RESTART);
        await vi.advanceTimersByTimeAsync(STEP_RETRY_BACKOFF_MS);
        await vi.waitFor(() => expect(spawned).toHaveLength(2));

        await crash('[ERROR] CLI exited with code 1\n\nsocket hang up');
        expect(await runOf(runId)).toMatchObject({
            status: 'waiting_for_owner',
            park_reason: 'The agent errored again after an automatic retry: CLI exited with code 1',
        });
        expect(await parkKind(runId)).toBe('step_error');
    });

    it('parks at once on an error a retry cannot fix', async () => {
        const runId = await startTaskRun('ATL-2');
        await crash('[ERROR] [error-kind:cli_not_installed:{"binary":"claude"}] Failed to spawn claude: spawn claude ENOENT');
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner', park_reason: expect.stringMatching(/^The agent errored: \[error-kind:cli_not_installed/) });
        await vi.advanceTimersByTimeAsync(STEP_RETRY_BACKOFF_MS);
        expect(spawned).toHaveLength(1);
    });

    it('does not respawn a run the Owner stopped during the backoff', async () => {
        const runId = await startTaskRun('ATL-2');
        const crashed = await crash(RESTART);
        await cancelWorkflowRun(runId);
        await vi.advanceTimersByTimeAsync(STEP_RETRY_BACKOFF_MS);
        await retryStep(runId, crashed);
        expect(spawned).toHaveLength(1);
        expect(await runOf(runId)).toMatchObject({ status: 'cancelled' });
    });
});

describe('task run — stop, reconcile, dispatch', () => {
    it('stopping the agent cancels the run, keeps pushed work, and opens no PR', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('cancelled', null);
        expect(await runOf(runId)).toMatchObject({ status: 'cancelled' });
        expect(git.pushWorktree).toHaveBeenCalledTimes(1);
        expect(git.openPullRequest).not.toHaveBeenCalled();
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'waiting_for_info' });
    });

    // The Owner stops the run and closes the Task while delivery is pushing:
    // whatever the push returns, the stop and the Owner's status stand.
    for (const push of [
        { pushed: false, alreadyUpToDate: false, error: 'project credential_id is not configured' },
        { pushed: true, alreadyUpToDate: false },
    ]) {
        it(`a stop during delivery stays stopped (push ${push.pushed ? 'ok' : 'failed'})`, async () => {
            const runId = await startTaskRun('ATL-2');
            git.pushWorktree.mockImplementationOnce(async () => {
                await cancelWorkflowRun(runId);
                await testDb.updateTable('items').set({ status: 'done' }).where('id', '=', 'ATL-2').execute();
                return push;
            });
            await finishStep('completed', 'done');
            expect(await runOf(runId)).toMatchObject({ status: 'cancelled' });
            expect(await itemOf('ATL-2')).toMatchObject({ status: 'done' });
            expect(git.openPullRequest).not.toHaveBeenCalled();
            expect(await tickWorkflowDispatch()).toBe(0);
        });
    }

    it('a stop while the worktree is being prepared starts no agent', async () => {
        let runId = '';
        git.ensureWorktree.mockImplementationOnce(async () => {
            runId = (await testDb.selectFrom('workflow_runs').select('id').executeTakeFirstOrThrow()).id;
            await cancelWorkflowRun(runId);
            await testDb.updateTable('items').set({ status: 'done' }).where('id', '=', 'ATL-2').execute();
            return { path: '/tmp/atlas-run-test', branch: 'atlas/task/ATL-2', freshlyCreated: true };
        });
        await startTaskRun('ATL-2');
        expect(spawned).toHaveLength(0);
        expect(await runOf(runId)).toMatchObject({ status: 'cancelled' });
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'done' });
    });

    it('cancelWorkflowRun stops the live agent run', async () => {
        const runId = await startTaskRun('ATL-2');
        await cancelWorkflowRun(runId);
        const step = await testDb.selectFrom('agent_runs').select('status').where('id', '=', spawned[0]!.runId).executeTakeFirstOrThrow(); // reason: one step was spawned at start
        expect(step.status).toBe('cancelled');
    });

    it('reconcile parks a running run whose agent died without reporting', async () => {
        const runId = await startTaskRun('ATL-2');
        await testDb.updateTable('agent_runs').set({ status: 'error' }).where('id', '=', spawned[0]!.runId).execute(); // reason: one step was spawned at start
        expect(await reconcileWorkflowRuns(new Date(Date.now() + 11 * 60 * 1000))).toBe(1);
        expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner' });
        expect(await parkKind(runId)).toBe('lost_step');
    });

    it('dispatch runs only ready Tasks with an agent, one at a time per repo', async () => {
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'Same repo', status: 'ready', assignee_agent_id: 'agent-solo' });
        await insertItem({ id: 'ATL-4', type: 'task', project_id: 'p1', title: 'Unassigned', status: 'ready', repo_ids: ['other'] });

        expect(await tickWorkflowDispatch()).toBe(1);
        // ATL-3 shares ATL-2's repo (ADR 0029) and ATL-4 has no agent.
        expect(await tickWorkflowDispatch()).toBe(0);
        // Parked still holds the repo.
        await finishStep('completed', 'asked_question', 'unclear');
        expect(await tickWorkflowDispatch()).toBe(0);
        const first = await testDb.selectFrom('workflow_runs').select('id').executeTakeFirstOrThrow();
        await cancelWorkflowRun(first.id);
        await vi.waitFor(async () => {
            const live = await testDb.selectFrom('workflow_runs').select(['item_id', 'status']).orderBy('started_at').execute();
            expect(live.map((r) => [r.item_id, r.status])).toEqual([
                ['ATL-2', 'cancelled'],
                ['ATL-3', 'running'],
            ]);
        });
    });

    it('dispatch skips a Task whose dependency is not done', async () => {
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'Blocker', status: 'in_review' });
        await insertItem({ id: 'ATL-4', type: 'task', project_id: 'p1', title: 'Free', status: 'ready', assignee_agent_id: 'agent-solo', repo_ids: ['other'] });
        await testDb.insertInto('item_links').values({ from_id: 'ATL-2', to_id: 'ATL-3', relation_type: 'depends_on' }).execute();

        expect(await tickWorkflowDispatch()).toBe(1);
        const live = await testDb.selectFrom('workflow_runs').select('item_id').execute();
        expect(live.map((r) => r.item_id)).toEqual(['ATL-4']);
    });

    it('assigning an agent to a draft Task queues it and starts it right away', async () => {
        await testDb.updateTable('items').set({ status: 'draft', assignee_agent_id: null }).where('id', '=', 'ATL-2').execute();
        await tasksService.assign('ATL-2', 'agent-solo');
        await vi.waitFor(() => expect(spawned).toHaveLength(1));
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'in_progress' });
    });

    it('a Task that cannot start steps out of the queue, notifies, and the next one runs', async () => {
        // Oldest in line, but its repos are gone (ADR 0018).
        await testDb
            .updateTable('items')
            .set({ repo_ids: JSON.stringify([]) as never, updated_at: new Date(Date.now() - 60_000).toISOString() })
            .where('id', '=', 'ATL-2')
            .execute();
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'Next', status: 'ready', assignee_agent_id: 'agent-solo', repo_ids: ['other'] });

        expect(await tickWorkflowDispatch()).toBe(1);
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'waiting_for_info' });
        expect(await itemOf('ATL-3')).toMatchObject({ status: 'in_progress' });
        const notes = await testDb.selectFrom('notifications').select(['link_url', 'kind']).where('event_type', '=', 'workflow_run').execute();
        expect(notes).toEqual([{ link_url: '/tasks/ATL-2', kind: 'needs_you' }]);
        expect(sendExternal.mock.calls[0]?.[2]).toBe('workflow.failed');
    });

    it('a kick during a pass runs one more pass after it', async () => {
        const first = kickWorkflowDispatch('a');
        expect(kickWorkflowDispatch('b')).toBe(first);
        await first;
        expect(spawned).toHaveLength(1);
    });
});

// A real repo whose origin/main is its first commit plus atlas's own
// .gitignore commit — so "no changes" is decided by real git.
function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@atlas.local');
    g('config', 'user.name', 'Atlas Test');
    writeFileSync(join(dir, 'README.md'), 'repo\n');
    g('add', '-A');
    g('commit', '-qm', 'init');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(dir, '.gitignore'), '.atlas/\n');
    g('add', '-A');
    g('commit', '-qm', 'chore(atlas): ignore Atlas scratch paths');
}

describe('task run — multi-repo Tasks (ADR 0017/0018)', () => {
    let base = '';
    let ws = '';
    const defaults = {
        ensureWorktree: git.ensureWorktree.getMockImplementation(),
        openPullRequest: git.openPullRequest.getMockImplementation(),
    };

    beforeEach(async () => {
        base = mkdtempSync(join(tmpdir(), 'atlas-multi-'));
        ws = join(base, 'worktrees', 'p1', 'ws', 'atlas__task__ATL-2');
        await testDb
            .updateTable('project_repos')
            .set({ name: 'core', git_path: join(base, 'core'), git_url: 'https://github.com/o/core' })
            .where('id', '=', 'p1')
            .execute();
        await testDb
            .insertInto('project_repos')
            .values({ id: 'repo-web', project_id: 'p1', name: 'web', git_url: 'https://github.com/o/web', git_path: join(base, 'web'), position: 1 })
            .execute();
        await testDb.updateTable('items').set({ repo_ids: JSON.stringify(['p1', 'repo-web']) }).where('id', '=', 'ATL-2').execute();
        git.ensureWorktree.mockImplementation((async (input: { path?: string; branch?: string }) => {
            if (input.path && !existsSync(input.path)) initRepo(input.path);
            return { path: input.path ?? '/tmp/atlas-run-test', branch: input.branch ?? '', freshlyCreated: true };
        }) as never);
        git.openPullRequest.mockImplementation((async (o: { worktreePath: string }) => ({
            opened: true,
            url: o.worktreePath.endsWith('web') ? 'https://github.com/o/web/pull/2' : 'https://github.com/o/core/pull/1',
            alreadyExists: false,
        })) as never);
    });

    afterEach(() => {
        git.ensureWorktree.mockImplementation(defaults.ensureWorktree as never);
        git.openPullRequest.mockImplementation(defaults.openPullRequest as never);
        rmSync(base, { recursive: true, force: true });
    });

    const linksOf = async () =>
        (await testDb.selectFrom('item_external_links').select('url').where('item_id', '=', 'ATL-2').orderBy('id').execute()).map((l) => l.url);

    it('works every repo side by side in one workspace and opens one cross-linked PR per repo', async () => {
        const runId = await startTaskRun('ATL-2');
        expect((await runOf(runId)).worktree_path).toBe(ws);

        writeFileSync(join(ws, 'core', 'api.txt'), 'endpoint\n');
        writeFileSync(join(ws, 'web', 'client.txt'), 'client\n');
        await finishStep('completed', 'done');

        expect(git.pushWorktree).toHaveBeenCalledWith(join(ws, 'core'), 'atlas/task/ATL-2', null, 'p1');
        expect(git.pushWorktree).toHaveBeenCalledWith(join(ws, 'web'), 'atlas/task/ATL-2', null, 'repo-web');
        expect(git.openPullRequest).toHaveBeenCalledTimes(4);
        expect(existsSync(ws)).toBe(false);
        expect(await linksOf()).toEqual(['https://github.com/o/core/pull/1', 'https://github.com/o/web/pull/2']);
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'in_review' });
    });

    // ADR 0015 — the agent only edits; Atlas's commit is the only one.
    it('commits the uncommitted edits as `<task key>: <task title>` before pushing', async () => {
        const atPush: string[] = [];
        git.pushWorktree.mockImplementationOnce((async (path: string) => {
            atPush.push(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s|%b'], { encoding: 'utf8' }).trim());
            atPush.push(execFileSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' }).trim());
            atPush.push(execFileSync('git', ['-C', path, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim());
            return { pushed: true, alreadyUpToDate: false };
        }) as never);
        await startTaskRun('ATL-2');
        writeFileSync(join(ws, 'core', 'api.txt'), 'endpoint\n');
        await finishStep('completed', 'done');

        expect(atPush).toEqual(['ATL-2: Task|', '', 'api.txt']);
        expect(git.openPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.stringMatching(/- Task: ATL-2\n- Agent: .+\n- Run: /) }),
        );
    });

    // A commit that fails must park with its own reason — pushing on past it
    // surfaced only GitHub's "No commits between main and …".
    it('parks with the commit error, and pushes nothing, when the commit fails', async () => {
        await startTaskRun('ATL-2');
        writeFileSync(join(ws, 'core', 'api.txt'), 'endpoint\n');
        mkdirSync(join(ws, 'core', '.husky', '_'), { recursive: true });
        writeFileSync(join(ws, 'core', '.husky', '_', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
        const runId = (await testDb.selectFrom('workflow_runs').select('id').where('item_id', '=', 'ATL-2').executeTakeFirstOrThrow()).id;
        await finishStep('completed', 'done');

        const run = await runOf(runId);
        expect(run).toMatchObject({ status: 'waiting_for_owner', parked_node_id: 'end' });
        expect(run.park_reason).toMatch(/^core: Commit failed: .*hook says no/s);
        expect(git.pushWorktree).not.toHaveBeenCalledWith(join(ws, 'core'), expect.anything(), expect.anything(), expect.anything());
        expect(execFileSync('git', ['-C', join(ws, 'core'), 'status', '--porcelain'], { encoding: 'utf8' })).toContain('api.txt');
    });

    it('skips a repo the Task did not change', async () => {
        await startTaskRun('ATL-2');
        writeFileSync(join(ws, 'core', 'api.txt'), 'endpoint\n');
        await finishStep('completed', 'done');
        expect(git.pushWorktree).toHaveBeenCalledTimes(1);
        expect(await linksOf()).toEqual(['https://github.com/o/core/pull/1']);
    });
});

// Found live: a single-repo Task that needed no change opened a PR holding
// only Atlas's own .gitignore commit.
describe('task run — a single-repo Task with no changes', () => {
    let dir = '';
    beforeEach(() => {
        dir = join(mkdtempSync(join(tmpdir(), 'atlas-single-')), 'wt');
        initRepo(dir);
        git.ensureWorktree.mockResolvedValueOnce({ path: dir, branch: 'atlas/task/ATL-2', freshlyCreated: true } as never);
    });
    afterEach(() => rmSync(dirname(dir), { recursive: true, force: true }));

    it('pushes nothing, opens no PR, and finishes the Task as done', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'done');
        expect(git.pushWorktree).not.toHaveBeenCalled();
        expect(git.openPullRequest).not.toHaveBeenCalled();
        expect(await runOf(runId)).toMatchObject({ status: 'completed', pr_url: null });
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'done' });
    });
});

describe('ADR 0033 — one slot for every run', () => {
    beforeEach(async () => {
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'Other repo', status: 'ready', assignee_agent_id: 'agent-solo', repo_ids: ['other'] });
    });
    const waitingTask = async () => (await listDispatchQueue()).map((e) => e.id);

    it('starts one Task at a time even when another repo is free', async () => {
        expect(await tickWorkflowDispatch()).toBe(1);
        expect(await countBusySlots()).toBe(1);
        expect(await tickWorkflowDispatch()).toBe(0);
        const queue = await listDispatchQueue();
        expect(queue).toHaveLength(1);
        expect(queue[0]?.blocked_reason).toBeNull();

        await finishStep('completed', 'done');
        await vi.waitFor(async () => expect(await itemOf(queue[0]?.id ?? '')).toMatchObject({ status: 'in_progress' }));
    });

    it('a parked run frees the slot', async () => {
        expect(await tickWorkflowDispatch()).toBe(1);
        const [next = ''] = await waitingTask();
        await finishStep('completed', 'asked_question', 'unclear');
        await vi.waitFor(async () => expect(await itemOf(next)).toMatchObject({ status: 'in_progress' }));
    });

    it('a queued itemless run waits its turn, holds the slot, and hands it on when it ends', async () => {
        await testDb.updateTable('items').set({ status: 'draft' }).where('id', 'in', ['ATL-2', 'ATL-3']).execute();
        const runId = await queueAgentRun('agent-solo', { collapse: false });
        // The update trigger stamps updated_at now: after the queued run.
        await testDb.updateTable('items').set({ status: 'ready' }).where('id', '=', 'ATL-3').execute();
        expect((await listDispatchQueue()).map((e) => e.kind)).toEqual(['agent_run', 'task']);

        expect(await tickWorkflowDispatch()).toBe(1);
        await vi.waitFor(() => expect(spawned).toEqual([expect.objectContaining({ runId })]));
        expect(await countBusySlots()).toBe(1);
        expect(await itemOf('ATL-3')).toMatchObject({ status: 'ready' });

        await testDb.updateTable('agent_runs').set({ status: 'completed' }).where('id', '=', runId).execute();
        await onStepFinished(runId);
        await vi.waitFor(async () => expect(await itemOf('ATL-3')).toMatchObject({ status: 'in_progress' }));
    });

    it('a failed spawn of an itemless run errors the row and frees the slot', async () => {
        await testDb.updateTable('items').set({ status: 'draft' }).where('id', 'in', ['ATL-2', 'ATL-3']).execute();
        const { spawnAgentRun } = await import('./agent-runner.js');
        vi.mocked(spawnAgentRun).mockRejectedValueOnce(new Error('cli missing'));
        const runId = await queueAgentRun('agent-solo');
        expect(await tickWorkflowDispatch()).toBe(1);
        await vi.waitFor(async () =>
            expect(await testDb.selectFrom('agent_runs').select(['status', 'outcome_summary']).where('id', '=', runId).executeTakeFirstOrThrow()).toEqual({
                status: 'error',
                outcome_summary: 'cli missing',
            }),
        );
    });
});

describe('ADR 0033 — a schedule gates pickup', () => {
    beforeEach(async () => {
        await testDb
            .updateTable('agents')
            .set({ schedule_enabled: true, schedule_next_run_at: new Date(Date.now() + 3_600_000).toISOString() })
            .where('id', '=', 'agent-solo')
            .execute();
    });

    it("holds a scheduled agent's Tasks until a fire, which buys exactly one", async () => {
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'Second', status: 'ready', assignee_agent_id: 'agent-solo', repo_ids: ['other'] });
        expect(await tickWorkflowDispatch()).toBe(0);
        expect((await listDispatchQueue()).map((e) => e.blocked_reason)).toEqual(['awaiting_schedule', 'awaiting_schedule']);

        await testDb.updateTable('agents').set({ schedule_due_at: new Date().toISOString() }).where('id', '=', 'agent-solo').execute();
        expect(await tickWorkflowDispatch()).toBe(1);
        const agent = await testDb.selectFrom('agents').select('schedule_due_at').where('id', '=', 'agent-solo').executeTakeFirstOrThrow();
        expect(agent.schedule_due_at).toBeNull();
        expect((await listDispatchQueue()).map((e) => e.blocked_reason)).toEqual(['awaiting_schedule']);
    });

    it('skips a fire that finds none of its Tasks ready', async () => {
        await testDb.updateTable('items').set({ status: 'draft' }).where('id', '=', 'ATL-2').execute();
        await testDb.updateTable('agents').set({ schedule_due_at: new Date().toISOString() }).where('id', '=', 'agent-solo').execute();
        expect(await tickWorkflowDispatch()).toBe(0);
        const agent = await testDb.selectFrom('agents').select('schedule_due_at').where('id', '=', 'agent-solo').executeTakeFirstOrThrow();
        expect(agent.schedule_due_at).toBeNull();
    });
});

describe("ADR 0033 — the agent's git flags decide delivery", () => {
    const flags = (git_commit: boolean, git_push: boolean, git_open_pr: boolean) =>
        testDb.updateTable('agents').set({ git_commit, git_push, git_open_pr }).where('id', '=', 'agent-solo').execute();

    it('commit + push without a PR: a branch, no PR, the Task is done', async () => {
        await flags(true, true, false);
        const runId = await startTaskRun('ATL-2');
        await finishStep('completed', 'done');
        expect(git.pushWorktree).toHaveBeenCalledTimes(1);
        expect(git.openPullRequest).not.toHaveBeenCalled();
        expect(git.cleanupWorktreeAfterPush).toHaveBeenCalledTimes(1);
        expect(await runOf(runId)).toMatchObject({ status: 'completed', pr_url: null });
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'done' });
    });

    it('commit only: nothing leaves the machine and the worktree stays', async () => {
        await flags(true, false, false);
        await startTaskRun('ATL-2');
        expect(git.ensureWorktree).toHaveBeenCalledWith(expect.objectContaining({ pushUpstream: false }));
        await finishStep('completed', 'done');
        expect(git.pushWorktree).not.toHaveBeenCalled();
        expect(git.cleanupWorktreeAfterPush).not.toHaveBeenCalled();
        expect(await itemOf('ATL-2')).toMatchObject({ status: 'done' });
    });

    it('all off: changes stay uncommitted and the Owner is told where', async () => {
        await flags(false, false, false);
        await startTaskRun('ATL-2');
        await finishStep('completed', 'done');
        expect(git.pushWorktree).not.toHaveBeenCalled();
        expect(git.cleanupWorktreeAfterPush).not.toHaveBeenCalled();
        const note = await testDb.selectFrom('notifications').select('message').where('message', 'like', 'Finished ATL-2%').executeTakeFirstOrThrow();
        expect(note.message).toContain('changes left uncommitted in /tmp/atlas-run-test');
    });

    it('with commits off, refuses to reset a worktree an earlier run left dirty', async () => {
        await flags(false, false, false);
        const repo = await testDb.selectFrom('project_repos').select(['id', 'git_path']).where('id', '=', 'p1').executeTakeFirstOrThrow();
        const path = computeWorktreePath(repo.git_path ?? '', repo.id, 'atlas/task/ATL-2');
        initRepo(path);
        writeFileSync(join(path, 'left.txt'), 'unsaved\n');
        try {
            const runId = await startTaskRun('ATL-2');
            expect(git.ensureWorktree).not.toHaveBeenCalled();
            expect(await runOf(runId)).toMatchObject({ status: 'waiting_for_owner' });
            expect(await parkKind(runId)).toBe('setup_failed');
        } finally {
            rmSync(path, { recursive: true, force: true });
        }
    });

    it('a stopped run keeps the flags but never opens a PR', async () => {
        await flags(true, false, false);
        const runId = await startTaskRun('ATL-2');
        await cancelWorkflowRun(runId);
        expect(git.pushWorktree).not.toHaveBeenCalled();
        expect(git.openPullRequest).not.toHaveBeenCalled();
    });
});
