import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExternalLinksModule from './external-links.js';
import type * as WorktreeOrchestratorModule from './worktree-orchestrator.js';
import { randomUUID } from 'node:crypto';
import type { RunOutcomeKind } from '@atlas/shared';

// Migration 024 — every park and resume leaves a row, on each path that parks
// or resumes a run. The engine is driven for real against the DB; only the
// CLI spawn and git are replaced, as in `workflow-engine.integration.test.ts`.
const spawned: Array<{ runId: string }> = [];
vi.mock('./agent-runner.js', () => ({
    spawnAgentRun: vi.fn(
        async (opts: { agentId: string; issueId?: string | null; workflowRun?: { id: string; nodeId: string } | null }) => {
            const { testDb } = await import('../../tests/_pg-db.js');
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
                    started_at: new Date().toISOString(),
                })
                .execute();
            spawned.push({ runId: id });
            return id;
        },
    ),
    cancelRun: vi.fn(async () => ({ cancelled: false, pidKilled: null })),
}));
vi.mock('./worktree-orchestrator.js', async (importOriginal) => ({
    ...(await importOriginal<typeof WorktreeOrchestratorModule>()),
    ensureWorktree: vi.fn(async () => ({ path: '/tmp/atlas-wf-test', branch: 'atlas/task/x', freshlyCreated: true })),
    pushWorktree: vi.fn(async () => ({ pushed: true, alreadyUpToDate: false })),
    openPullRequest: vi.fn(async () => ({ opened: true, url: 'https://github.com/o/r/pull/7', alreadyExists: false })),
    cleanupWorktreeAfterPush: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true, dbCleared: false, warnings: [] })),
}));
vi.mock('./external-links.js', async (importOriginal) => ({
    ...(await importOriginal<typeof ExternalLinksModule>()),
    fetchGithubPrTitle: vi.fn(async () => null),
}));
vi.mock('../routes/events.js', () => ({ eventsRoutes: async () => undefined, broadcastSSE: vi.fn() }));

import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent, insertItem, insertProject } from '../../tests/_items.js';
import { onStepFinished, reconcileWorkflowRuns, resumeWorkflowRun, startTaskRun } from './workflow-engine.js';
import { spawnAgentRun } from './agent-runner.js';
import { commentsService } from './comments.js';
import { recordRunEvent } from './workflow-run-events.js';

async function finishStep(outcome: RunOutcomeKind, reason: string): Promise<void> {
    const step = spawned.at(-1);
    if (!step) throw new Error('no step spawned');
    await testDb
        .updateTable('agent_runs')
        .set({ status: 'completed', completed_at: new Date().toISOString(), outcome_kind: outcome, outcome_reason: reason })
        .where('id', '=', step.runId)
        .execute();
    await onStepFinished(step.runId);
}

const eventsOf = (runId: string) =>
    testDb
        .selectFrom('workflow_run_events')
        .select(['kind', 'item_id', 'node_id', 'reason', 'park_kind'])
        .where('workflow_run_id', '=', runId)
        .orderBy('created_at', 'asc')
        .execute();

beforeEach(async () => {
    spawned.length = 0;
    await truncateAll();
    await insertProject('p1', 'ATL', { git_path: '/tmp/repo' });
    await insertAgent({ id: 'agent-solo', status: 'active' });
    await insertItem({ id: 'ATL-2', type: 'task', project_id: 'p1', title: 'Task', status: 'ready', assignee_agent_id: 'agent-solo' });
});

afterAll(closeTestDb);

describe('workflow run events', () => {
    it('writes a park with its reason, and the Resume button writes the resume', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('asked_question', 'Which API version?');

        expect(await eventsOf(runId)).toEqual([
            { kind: 'parked', item_id: 'ATL-2', node_id: 'agent', reason: 'Which API version?', park_kind: 'question' },
        ]);

        await resumeWorkflowRun(runId);
        expect((await eventsOf(runId)).map((e) => [e.kind, e.node_id])).toEqual([
            ['parked', 'agent'],
            ['resumed', 'agent'],
        ]);
        // The history survives what the run row forgets.
        const run = await testDb.selectFrom('workflow_runs').select('park_reason').where('id', '=', runId).executeTakeFirstOrThrow();
        expect(run.park_reason).toBeNull();
    });

    it('writes the resume when the Owner replies on the item', async () => {
        const runId = await startTaskRun('ATL-2');
        await finishStep('asked_question', 'Which API version?');
        await commentsService.create({ author: 'owner', issue_type: 'task', issue_id: 'ATL-2', body: 'v2' });
        await vi.waitFor(async () => expect(spawned).toHaveLength(2));
        expect((await eventsOf(runId)).map((e) => [e.kind, e.park_kind])).toEqual([
            ['parked', 'question'],
            ['resumed', null],
        ]);
    });

    // Migration 014 — every park site names its kind. (The rest are pinned in
    // `workflow-engine.integration.test.ts` next to each site's park reason.)
    describe('park kinds', () => {
        const kindOf = async (runId: string) => (await eventsOf(runId)).find((e) => e.kind === 'parked')?.park_kind;

        it('a rejection is rejected', async () => {
            const runId = await startTaskRun('ATL-2');
            await finishStep('rejected', 'out of scope');
            expect(await kindOf(runId)).toBe('rejected');
        });

        it('a done with a required checklist left unticked is checklist_failed', async () => {
            await testDb.insertInto('agent_checklists').values({ agent_id: 'agent-solo', label: 'Tests added', required: true } as never).execute();
            const runId = await startTaskRun('ATL-2');
            await finishStep('done', 'shipped');
            expect(await kindOf(runId)).toBe('checklist_failed');
        });

        it('an inactive agent is missing_agent', async () => {
            await testDb.updateTable('agents').set({ status: 'inactive' } as never).where('id', '=', 'agent-solo').execute();
            const runId = await startTaskRun('ATL-2');
            expect(await kindOf(runId)).toBe('missing_agent');
        });

        it('a spawn that throws is dispatch_failed', async () => {
            vi.mocked(spawnAgentRun).mockRejectedValueOnce(new Error('no slot'));
            const runId = await startTaskRun('ATL-2');
            expect(await kindOf(runId)).toBe('dispatch_failed');
        });

        it('a run whose step stopped reporting is lost_step', async () => {
            const runId = await startTaskRun('ATL-2');
            const step = spawned.at(-1);
            await testDb.updateTable('agent_runs').set({ status: 'completed' }).where('id', '=', step?.runId ?? '').execute();
            expect(await reconcileWorkflowRuns(new Date(Date.now() + 7 * 86_400_000))).toBe(1);
            expect(await kindOf(runId)).toBe('lost_step');
        });
    });

    // Best-effort: a history row must never break the engine it records.
    it('swallows a failed write instead of throwing into the engine', async () => {
        const runId = await startTaskRun('ATL-2');
        await expect(recordRunEvent(runId, 'bogus' as never)).resolves.toBeUndefined();
        await expect(recordRunEvent('no-such-run', 'parked', 'x', 'question')).resolves.toBeUndefined();
        expect(await eventsOf(runId)).toEqual([]);
    });
});
