import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

vi.mock('../routes/events.js', () => ({
    eventsRoutes: async () => {
        /* no-op */
    },
    broadcastSSE: vi.fn(),
}));

import { buildApp } from '../server.js';
import { truncateAll, closeTestDb, testDb } from '../../tests/_pg-db.js';
import { insertProject, insertAgent, insertItem } from '../../tests/_items.js';

let app: FastifyInstance;

beforeEach(async () => {
    await truncateAll();
    if (!app) {
        app = await buildApp({ logger: false });
        await app.ready();
    }
});

afterAll(async () => {
    if (app) await app.close();
    await closeTestDb();
});

describe('GET /api/counts', () => {
    it('returns 200 with sidenav counts structure', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/counts' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        // countsService.getSidenavCounts returns object with counts
        expect(typeof body).toBe('object');
    });

    it('returns count updates after inserting items', async () => {
        await insertProject('p1', 'ATL');
        await insertAgent({ id: 'agent-coder' });
        await insertItem({
            id: 'ATL-1',
            type: 'task',
            project_id: 'p1',
            title: 'Task',
            status: 'ready',
        });

        const res = await app.inject({ method: 'GET', url: '/api/counts' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.tasks).toBe(1);
        expect(body.sub_tasks).toBe(0);
    });
});

describe('GET /api/counts/project/:id', () => {
    it('returns 200 with project-scoped counts', async () => {
        await insertProject('p1', 'ATL');
        const res = await app.inject({ method: 'GET', url: '/api/counts/project/p1' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(typeof body).toBe('object');
    });

    it('returns 200 with empty/zero counts for unknown project', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/counts/project/no-such' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(typeof body).toBe('object');
    });
});

// Two projects: an open Task with an open and a done sub-task, an archived
// Task (done 10 days ago) whose open sub-task drops with it, a recently done
// Task, and a bare draft in the second project.
async function seedScopes() {
    await insertProject('p1', 'ATL');
    await insertProject('p2', 'BET');
    for (const id of ['a1', 'a2', 'a3']) await insertAgent({ id });
    await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', status: 'ready', assignee_agent_id: 'a1' });
    await insertItem({ id: 'ATL-2', type: 'sub_task', project_id: 'p1', parent_id: 'ATL-1', parent_type: 'task', status: 'in_progress', assignee_agent_id: 'a2' });
    await insertItem({ id: 'ATL-3', type: 'sub_task', project_id: 'p1', parent_id: 'ATL-1', parent_type: 'task', status: 'done', assignee_agent_id: 'a3' });
    await insertItem({ id: 'ATL-4', type: 'task', project_id: 'p1', status: 'done', assignee_agent_id: 'a3' });
    await insertItem({ id: 'ATL-5', type: 'sub_task', project_id: 'p1', parent_id: 'ATL-4', parent_type: 'task', status: 'ready', assignee_agent_id: 'a3' });
    await insertItem({ id: 'ATL-6', type: 'task', project_id: 'p1', status: 'done', assignee_agent_id: 'a2' });
    await insertItem({ id: 'BET-1', type: 'task', project_id: 'p2', status: 'draft' });
    // The updated_at trigger would stamp now(), un-archiving it.
    await sql`
        ALTER TABLE items DISABLE TRIGGER items_set_updated_at;
        UPDATE items SET updated_at = NOW() - INTERVAL '10 days' WHERE id = 'ATL-4';
        ALTER TABLE items ENABLE TRIGGER items_set_updated_at;
    `.execute(testDb);
}

describe('project Task totals match the lists they replace', () => {
    it('GET /api/counts/project/:id: task_count and active_agent_ids follow the issue tree', async () => {
        await seedScopes();
        const counts = JSON.parse((await app.inject({ method: 'GET', url: '/api/counts/project/p1' })).body);
        const tree = JSON.parse((await app.inject({ method: 'GET', url: '/api/issues/tree?project_id=p1' })).body);
        expect(counts.task_count).toBe(tree.tasks.length);
        expect(counts.task_count).toBe(2);
        // a3's only open work is under the archived Task; ATL-3 and ATL-6 are done.
        expect([...counts.active_agent_ids].sort()).toEqual(['a1', 'a2']);
    });

    it('GET /api/projects/task-summary: per-project totals equal /api/tasks grouped client-side', async () => {
        await seedScopes();
        const summary = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/task-summary' })).body);
        const tasks = JSON.parse((await app.inject({ method: 'GET', url: '/api/tasks' })).body) as Array<{
            project_id: string;
            sub_task_count: number;
            assignee_agent_id: string | null;
        }>;
        const expected = ['p1', 'p2'].map((project_id) => {
            const mine = tasks.filter((t) => t.project_id === project_id);
            return {
                project_id,
                task_count: mine.length,
                sub_task_count: mine.reduce((n, t) => n + t.sub_task_count, 0),
                assignee_agent_ids: [...new Set(mine.flatMap((t) => (t.assignee_agent_id ? [t.assignee_agent_id] : [])))].sort(),
            };
        });
        const got = [...summary]
            .sort((a, b) => a.project_id.localeCompare(b.project_id))
            .map((r) => ({ ...r, assignee_agent_ids: [...r.assignee_agent_ids].sort() }));
        expect(got).toEqual(expected);
        expect(got[0]).toEqual({ project_id: 'p1', task_count: 2, sub_task_count: 2, assignee_agent_ids: ['a1', 'a2'] });
    });
});

describe('GET /api/dashboard', () => {
    it('returns 200 with kpis, awaiting, queue', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('kpis');
        expect(body).toHaveProperty('awaiting');
        expect(body).toHaveProperty('queue');
    });

    it('returns correct array types for awaiting and queue', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.awaiting)).toBe(true);
        expect(Array.isArray(body.queue)).toBe(true);
    });
});

// The agent page's "Queue: N items". Counted here so the page no longer
// downloads every Task and sub-task in the workspace to count them.
describe('GET /api/counts/queue-by-agent', () => {
    it('counts ready and in-progress Tasks and sub-tasks per assignee, and nothing else', async () => {
        await insertProject('p1', 'ATL');
        await insertAgent({ id: 'agent-coder' });
        await insertAgent({ id: 'agent-writer' });
        await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'a', status: 'ready', assignee_agent_id: 'agent-coder' });
        await insertItem({ id: 'ATL-2', type: 'sub_task', project_id: 'p1', parent_id: 'ATL-1', title: 'b', status: 'in_progress', assignee_agent_id: 'agent-coder' });
        await insertItem({ id: 'ATL-3', type: 'task', project_id: 'p1', title: 'c', status: 'in_review', assignee_agent_id: 'agent-coder' });
        await insertItem({ id: 'ATL-4', type: 'task', project_id: 'p1', title: 'd', status: 'ready', assignee_agent_id: 'agent-writer' });
        await insertItem({ id: 'ATL-5', type: 'task', project_id: 'p1', title: 'e', status: 'ready' });

        const res = await app.inject({ method: 'GET', url: '/api/counts/queue-by-agent' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ 'agent-coder': 2, 'agent-writer': 1 });
    });
});
