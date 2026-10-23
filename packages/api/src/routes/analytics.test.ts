import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// SSE + notifications are no-op in tests; the analytics routes don't
// fire either, but the app boot wires them up so we mock anyway.
vi.mock('../routes/events.js', () => ({
    eventsRoutes: async () => {
        /* no-op */
    },
    broadcastSSE: vi.fn(),
}));
vi.mock('../services/notifications.js', () => ({
    notificationsService: {
        create: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        markAllRead: vi.fn(),
        markRead: vi.fn(),
        updateExternalStatus: vi.fn(),
    },
}));

import { sql } from 'kysely';
import { buildApp } from '../server.js';
import { truncateAll, closeTestDb, testDb } from '../../tests/_pg-db.js';
import { insertItem, insertProject, insertAgent } from '../../tests/_items.js';

let app: FastifyInstance;

beforeEach(async () => {
    // Close the previous app instance BEFORE truncating so the route pool
    // releases all connections. This prevents TRUNCATE from deadlocking
    // against connections kept open by Promise.all analytics queries.
    if (app) await app.close();
    await truncateAll();
    app = await buildApp({ logger: false });
    await app.ready();
});

afterAll(async () => {
    if (app) await app.close();
    await closeTestDb();
});

async function insertRun(opts: {
    id: string;
    item_id: string;
    status?: 'completed' | 'in_progress' | 'error' | 'cancelled';
    total_cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    completed_at?: string;
}): Promise<void> {
    await testDb
        .insertInto('agent_runs')
        .values({
            id: opts.id,
            agent_id: 'agent-coder',
            item_id: opts.item_id,
            status: opts.status ?? 'completed',
            total_cost_usd: opts.total_cost_usd ?? 0,
            input_tokens: opts.input_tokens ?? 0,
            output_tokens: opts.output_tokens ?? 0,
            cache_read_tokens: opts.cache_read_tokens ?? 0,
            completed_at: opts.completed_at ?? new Date().toISOString(),
        })
        .execute();
}

describe('GET /api/analytics — params', () => {
    it('defaults to month in UTC with a zero-filled series on an empty DB', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/analytics' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toContain('max-age=30');
        const body = res.json();
        expect(body.period).toMatchObject({ window: 'month', tz: 'UTC', bucket: 'day' });
        const now = new Date();
        expect(body.period.start).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
        expect(body).toMatchObject({ tasks_shipped: 0, prs_merged: 0, cycle_p50_s: null, spend_usd: 0 });
        expect(body.series).toHaveLength(now.getUTCDate());
        expect(Object.keys(body).sort()).toEqual(['cycle_p50_s', 'period', 'prs_merged', 'series', 'spend_usd', 'tasks_shipped']);
    });

    it('accepts a real zone and window', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/analytics?tz=Asia/Kolkata&window=90d' });
        expect(res.statusCode).toBe(200);
        expect(res.json().period).toMatchObject({ window: '90d', tz: 'Asia/Kolkata', bucket: 'week' });
    });

    for (const bad of ['window=1y', 'tz=Mars/Olympus', 'days=30']) {
        it(`?${bad} is a 400`, async () => {
            const res = await app.inject({ method: 'GET', url: `/api/analytics?${bad}` });
            expect(res.statusCode).toBe(400);
            expect(res.json().kind).toBe('validation_error');
        });
    }

    for (const path of ['/api/analytics/delivery', '/api/analytics/project/p1', '/api/analytics/task/t1']) {
        it(`${path} is gone`, async () => {
            expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
        });
    }
});

describe('agent-test runs are not spend, and the Dashboard month agrees with Analytics', () => {
    it('leaves is_test runs out of spend; standalone runs stay in', async () => {
        await insertProject('p1');
        await insertAgent({ id: 'agent-coder' });
        const real = await insertItem({ type: 'task', project_id: 'p1', title: 'Real' });
        const probe = await insertItem({ type: 'task', project_id: 'p1', title: 'Agent test' });
        await testDb.updateTable('items').set({ is_test: true } as never).where('id', '=', probe).execute();
        await insertRun({ id: 'r-real', item_id: real, total_cost_usd: 2 });
        await insertRun({ id: 'r-test', item_id: probe, total_cost_usd: 5 });
        await testDb
            .insertInto('agent_runs')
            .values({ id: 'r-free', agent_id: 'agent-coder', item_id: null, status: 'completed', total_cost_usd: 1, completed_at: new Date().toISOString() } as never)
            .execute();

        const tz = 'Asia/Kolkata';
        const a = (await app.inject({ method: 'GET', url: `/api/analytics?tz=${tz}&window=month` })).json();
        expect(a.spend_usd).toBeCloseTo(3, 5);
        expect(a.series.reduce((n: number, b: { spend_usd: number }) => n + b.spend_usd, 0)).toBeCloseTo(3, 5);

        const d = (await app.inject({ method: 'GET', url: `/api/dashboard?tz=${tz}` })).json();
        expect(d.kpis.costSummary30d.total_cost_usd).toBeCloseTo(a.spend_usd, 5);
    });

    it('the Dashboard month starts at the viewer-zone month start, like Analytics', async () => {
        await insertProject('p1');
        await insertAgent({ id: 'agent-coder' });
        const t = await insertItem({ type: 'task', project_id: 'p1', title: 'T' });
        // 30 minutes after the month began in Pacific/Kiritimati (UTC+14) — still last month in UTC.
        const { rows } = await sql<{ at: string }>`
            SELECT to_char(((date_trunc('month', now() AT TIME ZONE 'Pacific/Kiritimati') + interval '30 minutes') AT TIME ZONE 'Pacific/Kiritimati') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`.execute(testDb);
        await insertRun({ id: 'r-edge', item_id: t, total_cost_usd: 4, completed_at: rows[0]!.at });
        for (const tz of ['Pacific/Kiritimati', 'UTC']) {
            const a = (await app.inject({ method: 'GET', url: `/api/analytics?tz=${tz}` })).json();
            const d = (await app.inject({ method: 'GET', url: `/api/dashboard?tz=${tz}` })).json();
            expect(d.kpis.costSummary30d.total_cost_usd, tz).toBeCloseTo(a.spend_usd, 5);
        }
    });
});
