import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorktreeOrchestratorModule from '../services/worktree-orchestrator.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

vi.mock('../routes/events.js', () => ({ eventsRoutes: async () => undefined, broadcastSSE: vi.fn() }));
vi.mock('../services/external-notifications.js', () => ({ sendExternalForNotification: vi.fn(async () => {}) }));

// A step spawn only records a live agent_runs row; no CLI, no git.
vi.mock('../services/agent-runner.js', () => ({
    spawnAgentRun: vi.fn(async (opts: { agentId: string; issueId?: string | null; workflowRun?: { id: string; nodeId: string } | null }) => {
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
            })
            .execute();
        return id;
    }),
    runOutputRegistry: new Map<string, string>(),
    cancelRun: vi.fn(async () => ({ cancelled: false, pidKilled: null })),
}));
vi.mock('../services/worktree-orchestrator.js', async (importOriginal) => ({
    ...(await importOriginal<typeof WorktreeOrchestratorModule>()),
    ensureWorktree: vi.fn(async () => ({ path: '/tmp/wf', branch: 'atlas/task/x', freshlyCreated: true })),
    pushWorktree: vi.fn(async () => ({ pushed: true, alreadyUpToDate: false })),
    openPullRequest: vi.fn(async () => ({ opened: false, url: null, alreadyExists: false })),
    cleanupWorktreeAfterPush: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true, dbCleared: false, warnings: [] })),
}));

import { buildApp } from '../server.js';
import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent, insertItem, insertProject } from '../../tests/_items.js';
import { onStepFinished, startTaskRun } from '../services/workflow-engine.js';

let app: FastifyInstance;

const stepOf = (runId: string) =>
    testDb.selectFrom('agent_runs').select('id').where('workflow_run_id', '=', runId).executeTakeFirstOrThrow();

/** Parks the run the way a step that ends without an outcome block does. */
async function park(runId: string): Promise<void> {
    const step = await stepOf(runId);
    await testDb.updateTable('agent_runs').set({ status: 'completed', completed_at: new Date().toISOString() }).where('id', '=', step.id).execute();
    await onStepFinished(step.id);
}

beforeEach(async () => {
    await truncateAll();
    await insertProject('p1', 'ATL', { git_path: '/tmp/repo' });
    await insertAgent({ id: 'agent-solo', status: 'active' });
    await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'Task', status: 'ready', assignee_agent_id: 'agent-solo' });
    app ??= await buildApp({ logger: false });
    await app.ready();
});

afterAll(async () => {
    if (app) await app.close();
    await closeTestDb();
});

describe('task runs over HTTP', () => {
    it('shows a run with its step, lists it on the item, and stops it', async () => {
        const runId = await startTaskRun('ATL-1');

        const detail = await app.inject({ method: 'GET', url: `/api/workflow-runs/${runId}` });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({ workflow_id: 'solo', status: 'running', item_title: 'Task', current_node_id: 'agent' });
        expect(detail.json().steps).toEqual([expect.objectContaining({ agent_id: 'agent-solo', node_id: 'agent' })]);

        const itemRuns = await app.inject({ method: 'GET', url: '/api/items/ATL-1/workflow-runs' });
        expect(itemRuns.json().map((r: { id: string }) => r.id)).toEqual([runId]);

        const stopped = await app.inject({ method: 'POST', url: `/api/workflow-runs/${runId}/stop` });
        expect(stopped.statusCode).toBe(200);
        expect(stopped.json()).toMatchObject({ status: 'cancelled' });

        // Only a parked run can be resumed.
        const resume = await app.inject({ method: 'POST', url: `/api/workflow-runs/${runId}/resume` });
        expect(resume.statusCode).toBe(409);
    });

    it('resumes a parked run, re-running the agent', async () => {
        const runId = await startTaskRun('ATL-1');
        await park(runId);
        expect((await app.inject({ method: 'GET', url: `/api/workflow-runs/${runId}` })).json()).toMatchObject({ status: 'waiting_for_owner' });

        const res = await app.inject({ method: 'POST', url: `/api/workflow-runs/${runId}/resume` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: 'running', current_node_id: 'agent' });
        expect(res.json().steps).toHaveLength(2);
    });

    it('resuming a run that is already running is harmless', async () => {
        const runId = await startTaskRun('ATL-1');
        const res = await app.inject({ method: 'POST', url: `/api/workflow-runs/${runId}/resume` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: 'running' });
    });

    it('404s a run that does not exist', async () => {
        for (const [method, url] of [
            ['GET', '/api/workflow-runs/no-such-run'],
            ['GET', '/api/workflow-runs/no-such-run/diff'],
            ['POST', '/api/workflow-runs/no-such-run/stop'],
            ['POST', '/api/workflow-runs/no-such-run/resume'],
        ] as const) {
            const res = await app.inject({ method, url });
            expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
        const none = await app.inject({ method: 'GET', url: '/api/items/ATL-1/workflow-runs' });
        expect(none.json()).toEqual([]);
    });

    it('rejects a diff/file query without its required fields', async () => {
        const runId = await startTaskRun('ATL-1');
        const res = await app.inject({ method: 'GET', url: `/api/workflow-runs/${runId}/diff/file?path=a.ts` });
        expect(res.statusCode).toBe(400);
    });

    it('locks item status and assignee while a run is working it', async () => {
        await startTaskRun('ATL-1');
        const status = await app.inject({ method: 'PATCH', url: '/api/tasks/ATL-1/status', payload: { status: 'done' } });
        expect(status.statusCode).toBe(409);
        const assign = await app.inject({ method: 'PATCH', url: '/api/tasks/ATL-1/assign', payload: { assignee_agent_id: null } });
        expect(assign.statusCode).toBe(409);
        // Field edits stay allowed.
        const fields = await app.inject({ method: 'PATCH', url: '/api/tasks/ATL-1', payload: { title: 'Task renamed' } });
        expect(fields.statusCode).toBe(200);
    });

    it('deleting the run’s step cancels the run and hands the Task back', async () => {
        const runId = await startTaskRun('ATL-1');
        const del = await app.inject({ method: 'DELETE', url: `/api/run/${(await stepOf(runId)).id}` });
        expect(del.statusCode).toBe(204);
        const run = await testDb.selectFrom('workflow_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow();
        expect(run.status).toBe('cancelled');
        const item = await testDb.selectFrom('items').select('status').where('id', '=', 'ATL-1').executeTakeFirstOrThrow();
        expect(item.status).toBe('waiting_for_info');
    });

    it('stopping the run’s step through /api/run stops the run', async () => {
        const runId = await startTaskRun('ATL-1');
        await app.inject({ method: 'POST', url: `/api/run/${(await stepOf(runId)).id}/stop` });
        const run = await testDb.selectFrom('workflow_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow();
        expect(run.status).toBe('cancelled');
    });

    it('a run’s cost is the sum of its steps', async () => {
        const runId = await startTaskRun('ATL-1');
        await testDb.updateTable('agent_runs').set({ total_cost_usd: 0.25 }).where('workflow_run_id', '=', runId).execute();
        await testDb
            .insertInto('agent_runs')
            .values({ id: randomUUID(), agent_id: 'agent-solo', item_id: 'ATL-1', status: 'completed', workflow_run_id: runId, node_id: 'agent', total_cost_usd: 1.5 })
            .execute();
        const detail = (await app.inject({ method: 'GET', url: `/api/workflow-runs/${runId}` })).json();
        expect(detail.total_cost_usd).toBeCloseTo(1.75);
    });
});
