import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { IQueue } from '@atlas/shared';

vi.mock('../routes/events.js', () => ({ eventsRoutes: async () => undefined, broadcastSSE: vi.fn() }));
// Dispatch kicks must not spawn anything here; the queue only reads state.
vi.mock('../services/agent-runner.js', async (orig) => ({
    ...(await orig<object>()),
    spawnAgentRun: vi.fn(async () => 'x'),
}));

import { buildApp } from '../server.js';
import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent, insertItem, insertProject } from '../../tests/_items.js';

let app: FastifyInstance;

beforeEach(async () => {
    await truncateAll();
    if (!app) {
        app = await buildApp({ logger: false });
        await app.ready();
    }
    await insertProject('p1', 'ATL', { git_path: '/tmp/repo' });
    await insertAgent({ id: 'solo', name: 'Solo', status: 'active' });
    await insertAgent({ id: 'news', name: 'News', status: 'active' });
    await testDb
        .insertInto('workflows')
        .values({ id: 'solo', name: 'Single agent', status: 'inactive', input_kind: 'none', trigger: 'manual', use_worktree: false })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
});

afterAll(async () => {
    if (app) await app.close();
    await closeTestDb();
});

const getQueue = async (): Promise<IQueue> => {
    const res = await app.inject({ method: 'GET', url: '/api/queue' });
    expect(res.statusCode).toBe(200);
    return res.json() as IQueue;
};

describe('GET /api/queue', () => {
    it('is empty with one slot when nothing waits', async () => {
        expect(await getQueue()).toEqual({ slots: 1, running: [], waiting: [], scheduled: [] });
    });

    it('lists the running Task, the running itemless run, what waits, and the scheduled agents', async () => {
        await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'Running', status: 'in_progress', assignee_agent_id: 'solo' });
        await insertItem({ id: 'ATL-2', type: 'task', project_id: 'p1', title: 'Waiting', status: 'ready', assignee_agent_id: 'solo', repo_ids: ['other'] });
        const wr = randomUUID();
        await testDb
            .insertInto('workflow_runs')
            .values({ id: wr, workflow_id: 'solo', item_id: 'ATL-1', project_id: 'p1', graph_snapshot: JSON.stringify({ nodes: [], edges: [] }), branch: 'atlas/task/ATL-1' })
            .execute();
        const ar = randomUUID();
        await testDb.insertInto('agent_runs').values({ id: ar, agent_id: 'news', status: 'in_progress', started_at: new Date().toISOString() }).execute();
        await testDb
            .updateTable('agents')
            .set({ schedule_enabled: true, requires_item: false, schedule_next_run_at: '2026-10-28T09:00:00Z' })
            .where('id', '=', 'news')
            .execute();

        const q = await getQueue();
        expect(q.running).toEqual([
            expect.objectContaining({ kind: 'task', id: 'ATL-1', title: 'Running', agent_name: 'Solo', run_id: wr }),
            expect.objectContaining({ kind: 'agent_run', id: ar, title: 'News run', run_id: ar }),
        ]);
        expect(q.waiting).toEqual([expect.objectContaining({ kind: 'task', id: 'ATL-2', blocked_reason: null })]);
        expect(q.waiting[0]).not.toHaveProperty('scheduled');
        expect(q.scheduled).toEqual([
            {
                agent_id: 'news',
                agent_name: 'News',
                accent_color: expect.any(String),
                requires_item: false,
                schedule_cron_expression: '0 9 * * *',
                schedule_next_run_at: '2026-10-28T09:00:00.000Z',
                schedule_due_at: null,
            },
        ]);
    });
});

describe('ADR 0033 at the API boundary', () => {
    it('Run now queues the run and returns its id', async () => {
        await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'Busy', status: 'in_progress', assignee_agent_id: 'solo' });
        await testDb
            .insertInto('workflow_runs')
            .values({ id: randomUUID(), workflow_id: 'solo', item_id: 'ATL-1', project_id: 'p1', graph_snapshot: JSON.stringify({ nodes: [], edges: [] }), branch: 'atlas/task/ATL-1' })
            .execute();
        const res = await app.inject({ method: 'POST', url: '/api/run', payload: { agent_id: 'news' } });
        expect(res.statusCode).toBe(202);
        const { runId } = res.json() as { runId: string };
        expect((await getQueue()).waiting).toEqual([expect.objectContaining({ kind: 'agent_run', id: runId })]);
    });

    it('refuses to assign a Task to an agent that runs on its own', async () => {
        await testDb.updateTable('agents').set({ requires_item: false }).where('id', '=', 'news').execute();
        await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'T', status: 'draft' });
        const res = await app.inject({ method: 'PATCH', url: '/api/tasks/ATL-1/assign', payload: { assignee_agent_id: 'news' } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('runs on its own');
        const create = await app.inject({ method: 'POST', url: '/api/tasks', payload: { project_id: 'p1', title: 'New', assignee_agent_id: 'news' } });
        expect(create.statusCode).toBe(400);
    });

    it('PATCH /api/agents/:id saves run config and rejects a broken chain', async () => {
        const ok = await app.inject({
            method: 'PATCH',
            url: '/api/agents/solo',
            payload: { git_open_pr: false, schedule_enabled: true, schedule_preset: 'hourly' },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ git_open_pr: false, schedule_enabled: true, schedule_cron_expression: '0 * * * *' });
        expect(ok.json().schedule_next_run_at).toEqual(expect.any(String));

        const bad = await app.inject({ method: 'PATCH', url: '/api/agents/solo', payload: { git_commit: false } });
        expect(bad.statusCode).toBe(400);
        const badBody = await app.inject({ method: 'PATCH', url: '/api/agents/solo', payload: { git_commit: false, git_push: true } });
        expect(badBody.statusCode).toBe(400);
    });
});
