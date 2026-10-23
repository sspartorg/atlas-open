import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../routes/events.js', () => ({ broadcastSSE: vi.fn() }));

import { analytics, percentileCont } from './analytics.js';
import { resolveWindow } from './analytics-window.js';
import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent, insertItem, insertProject } from '../../tests/_items.js';

// The /analytics numbers over hand-built status histories. The clock is pinned to
// 2026-10-16 06:30Z = 12:00 in Asia/Kolkata (UTC+5:30), so the 7-day window
// is Oct 10 00:00 IST (2026-10-09T18:30Z) → now. Every expected number below is worked
// out by hand in the comment next to it.

const NOW = new Date('2026-10-16T06:30:00Z');
const TZ = 'Asia/Kolkata';

async function item(
    id: string,
    over: {
        type?: 'task' | 'sub_task';
        project?: string;
        status: string;
        created: string;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        parent?: string;
        is_test?: boolean;
    },
): Promise<void> {
    await insertItem({
        id,
        type: over.type ?? 'task',
        project_id: over.project ?? 'p1',
        status: over.status,
        priority: over.priority ?? 'normal',
        ...(over.parent ? { parent_id: over.parent, parent_type: 'task' as const } : {}),
    });
    await testDb
        .updateTable('items')
        .set({ created_at: over.created, is_test: over.is_test ?? false } as never)
        .where('id', '=', id)
        .execute();
}

/** A status path: [from, to, at] triples, in order. */
async function moves(id: string, path: Array<[string, string, string]>): Promise<void> {
    for (const [from, to, at] of path) {
        await testDb
            .insertInto('issue_events')
            .values({ item_id: id, event_type: 'status_changed', field: 'status', from_value: from, to_value: to, created_at: at } as never)
            .execute();
    }
}

async function seed(): Promise<void> {
    await insertProject('p1', 'ATL');
    await insertProject('p2', 'JRA');

    // A — high. lead 10h, cycle 8h (first In progress 02:00 → Done 10:00).
    // draft 1h, ready 1h, in_progress 2h+2h, waiting 2h, in_review 2h.
    await item('A', { status: 'done', created: '2026-10-11T00:00:00Z', priority: 'high' });
    await moves('A', [
        ['draft', 'ready', '2026-10-11T01:00:00Z'],
        ['ready', 'in_progress', '2026-10-11T02:00:00Z'],
        ['in_progress', 'waiting_for_info', '2026-10-11T04:00:00Z'],
        ['waiting_for_info', 'in_progress', '2026-10-11T06:00:00Z'],
        ['in_progress', 'in_review', '2026-10-11T08:00:00Z'],
        ['in_review', 'done', '2026-10-11T10:00:00Z'],
    ]);
    // S1 — A's sub-task, shipped Oct 11 14:30 IST.
    await item('S1', { type: 'sub_task', parent: 'A', status: 'done', created: '2026-10-11T00:00:00Z' });
    await moves('S1', [['draft', 'done', '2026-10-11T09:00:00Z']]);

    // B — lead 5h, cycle 4h. draft 1h, in_progress 4h.
    await item('B', { status: 'done', created: '2026-10-12T00:00:00Z' });
    await moves('B', [
        ['draft', 'in_progress', '2026-10-12T01:00:00Z'],
        ['in_progress', 'done', '2026-10-12T05:00:00Z'],
    ]);

    // C — Jira-sourced, p2. Straight to Done (no cycle time), lead 20h, all of
    // it draft. Done at 20:00Z = Oct 15 01:30 IST, so it buckets on Oct 15
    // here and on Oct 14 in UTC. Then reopened and in progress again → WIP,
    // aged from the reopen's In progress (Oct 15 00:00Z): 30.5h.
    await item('C', { project: 'p2', status: 'in_progress', created: '2026-10-14T00:00:00Z' });
    await moves('C', [
        ['draft', 'done', '2026-10-14T20:00:00Z'],
        ['done', 'in_progress', '2026-10-15T00:00:00Z'],
    ]);
    await testDb
        .insertInto('item_external_links')
        .values({ item_id: 'C', link_kind: 'jira_issue', url: 'https://x.atlassian.net/browse/J-1' } as never)
        .execute();

    // E — Done at exactly the window start (inclusive). lead 30m, cycle 20m.
    await item('E', { status: 'done', created: '2026-10-09T18:00:00Z' });
    await moves('E', [
        ['draft', 'in_progress', '2026-10-09T18:10:00Z'],
        ['in_progress', 'done', '2026-10-09T18:30:00Z'],
    ]);

    // D — one minute before the window: the previous window's only ship.
    // cycle = 10:00Z → 18:29Z = 8h29m = 30540s.
    await item('D', { status: 'done', created: '2026-10-09T00:00:00Z' });
    await moves('D', [
        ['draft', 'in_progress', '2026-10-09T10:00:00Z'],
        ['in_progress', 'done', '2026-10-09T18:29:00Z'],
    ]);

    // F — waiting for you since 00:30Z today: an open park, 6h to now. WIP, aged 18.5h.
    await item('F', { status: 'waiting_for_info', created: '2026-10-15T00:00:00Z' });
    await moves('F', [
        ['draft', 'in_progress', '2026-10-15T12:00:00Z'],
        ['in_progress', 'waiting_for_info', '2026-10-16T00:30:00Z'],
    ]);

    // W — in progress since Oct 1: aging WIP (15d 6.5h).
    await item('W', { status: 'in_progress', created: '2026-09-30T00:00:00Z' });
    await moves('W', [['draft', 'in_progress', '2026-10-01T00:00:00Z']]);

    // T — an agent test's item: shipped in the window, counted nowhere.
    await item('T', { status: 'done', created: '2026-10-11T00:00:00Z', is_test: true });
    await moves('T', [
        ['draft', 'in_progress', '2026-10-11T00:00:00Z'],
        ['in_progress', 'waiting_for_info', '2026-10-11T00:10:00Z'],
        ['waiting_for_info', 'done', '2026-10-11T00:20:00Z'],
    ]);
}

beforeEach(async () => {
    await truncateAll();
});

afterAll(async () => {
    await closeTestDb();
});

describe('percentileCont', () => {
    it('interpolates like Postgres percentile_cont', () => {
        expect(percentileCont([], 0.5)).toBeNull();
        expect(percentileCont([5], 0.9)).toBe(5);
        expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
        expect(percentileCont([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    });
});

describe('resolveWindow', () => {
    it('resolves each window in the viewer tz', async () => {
        expect(await resolveWindow(TZ, '7d', NOW)).toEqual({
            window: '7d',
            tz: TZ,
            bucket: 'day',
            start: '2026-10-09T18:30:00.000Z',
            end: '2026-10-16T06:30:00.000Z',
        });
        expect((await resolveWindow(TZ, 'month', NOW)).start).toBe('2026-09-30T18:30:00.000Z');
        expect((await resolveWindow(TZ, '90d', NOW)).bucket).toBe('week');
        expect((await resolveWindow('UTC', '30d', NOW)).start).toBe('2026-09-17T00:00:00.000Z');
    });
});

describe('analytics', () => {
    it('answers an empty workspace with zeros, a null median and zero-filled buckets', async () => {
        const a = await analytics({ tz: TZ, window: '7d', now: NOW });
        expect(a).toMatchObject({ tasks_shipped: 0, prs_merged: 0, cycle_p50_s: null, spend_usd: 0 });
        expect(a.series).toHaveLength(7);
        expect(a.series.every((b) => b.tasks_shipped === 0 && b.spend_usd === 0)).toBe(true);
    });

    it('counts shipped Tasks and their median cycle time from the status history', async () => {
        await seed();
        const a = await analytics({ tz: TZ, window: '7d', now: NOW });
        // A, B, C, E shipped (D is before the window, T is a test, S1 a sub-task).
        expect(a.tasks_shipped).toBe(4);
        // Cycle [E 1200, B 14400, A 28800] (C has none).
        expect(a.cycle_p50_s).toBe(14400);
        // Local-day buckets: E Oct 10 00:00 IST, A Oct 11, B Oct 12, C Oct 15.
        expect(a.series.map((b) => [b.bucket, b.tasks_shipped])).toEqual([
            ['2026-10-10', 1],
            ['2026-10-11', 1],
            ['2026-10-12', 1],
            ['2026-10-13', 0],
            ['2026-10-14', 0],
            ['2026-10-15', 1],
            ['2026-10-16', 0],
        ]);
    });

    it('buckets by the viewer tz: the same Done lands a day earlier in UTC', async () => {
        await seed();
        const a = await analytics({ tz: 'UTC', window: '7d', now: NOW });
        // UTC window starts Oct 10 00:00Z, so E (Oct 9 18:30Z) is out.
        expect(a.tasks_shipped).toBe(3);
        expect(a.series.find((b) => b.bucket === '2026-10-14')?.tasks_shipped).toBe(1);
        expect(a.series.find((b) => b.bucket === '2026-10-15')?.tasks_shipped).toBe(0);
    });

    it('rolls 90 days into Monday weeks', async () => {
        await seed();
        const a = await analytics({ tz: TZ, window: '90d', now: NOW });
        expect(a.period.bucket).toBe('week');
        // Oct 12 is a Monday: D (Fri), E (Sat) and A (Sun) are the week of Oct 5; B and C the week of Oct 12.
        const wk = Object.fromEntries(a.series.map((b) => [b.bucket, b.tasks_shipped]));
        expect(wk['2026-10-05']).toBe(3);
        expect(wk['2026-10-12']).toBe(2);
        expect(a.tasks_shipped).toBe(5);
    });

    it('counts merged PRs of the Task runs started in the window', async () => {
        await insertProject('p1', 'ATL');
        await insertAgent({ id: 'agent-coder', status: 'active' });
        await testDb
            .insertInto('workflows')
            .values({ id: 'wf', project_id: 'p1', name: 'Delivery', graph: JSON.stringify({ nodes: [], edges: [] }), input_kind: 'item', trigger: 'manual' } as never)
            .execute();
        for (const id of ['X', 'Y', 'Z', 'P']) await item(id, { status: 'in_progress', created: '2026-10-01T00:00:00Z' });
        await item('TT', { status: 'in_progress', created: '2026-10-01T00:00:00Z', is_test: true });
        const run = async (id: string, started: string, itemId: string, prs: string[]) => {
            await testDb
                .insertInto('workflow_runs')
                .values({
                    id, workflow_id: 'wf', project_id: 'p1', item_id: itemId, status: 'completed',
                    graph_snapshot: JSON.stringify({ nodes: [], edges: [] }), started_at: started, pr_urls: JSON.stringify(prs),
                } as never)
                .execute();
        };
        const pr = async (itemId: string, url: string, state: string, at: string) => {
            await testDb
                .insertInto('item_external_links')
                .values({ item_id: itemId, link_kind: 'pull_request', url, pr_state: state, created_at: at } as never)
                .execute();
        };
        // X: one merged; Y: two merged; Z: still open; P: last week's; TT: an agent test's.
        await run('wr1', '2026-10-11T00:00:00Z', 'X', ['u1']);
        await run('wr2', '2026-10-13T00:00:00Z', 'Y', ['u2', 'u3']);
        await run('wr3', '2026-10-14T00:00:00Z', 'Z', ['u4']);
        await run('wr0', '2026-10-05T00:00:00Z', 'P', ['u5']);
        await run('wt', '2026-10-12T00:00:00Z', 'TT', ['u6']);
        await pr('X', 'u1', 'merged', '2026-10-11T01:00:00Z');
        await pr('Y', 'u2', 'merged', '2026-10-13T02:00:00Z');
        await pr('Y', 'u3', 'merged', '2026-10-13T03:00:00Z');
        await pr('Z', 'u4', 'open', '2026-10-14T03:00:00Z');
        await pr('P', 'u5', 'merged', '2026-10-05T03:00:00Z');
        await pr('TT', 'u6', 'merged', '2026-10-12T03:00:00Z');

        expect((await analytics({ tz: 'UTC', window: '7d', now: NOW })).prs_merged).toBe(3);
    });

    it('sums spend from completed agent runs and closed terminal sessions, agent tests left out', async () => {
        await insertProject('p1', 'ATL');
        await insertAgent({ id: 'agent-coder' });
        await item('R', { status: 'in_progress', created: '2026-10-01T00:00:00Z' });
        await item('TT', { status: 'in_progress', created: '2026-10-01T00:00:00Z', is_test: true });
        const agentRun = async (id: string, itemId: string | null, usd: number, at: string, status = 'completed') => {
            await testDb
                .insertInto('agent_runs')
                .values({ id, agent_id: 'agent-coder', item_id: itemId, status, total_cost_usd: usd, completed_at: at } as never)
                .execute();
        };
        const session = async (id: string, usd: number, at: string, status = 'closed') => {
            await testDb
                .insertInto('cli_sessions')
                .values({
                    id, project_id: 'p1', title: id, status, cli: 'claude', worktree_path: '/tmp/t', worktree_branch: `atlas/terminal/${id}`,
                    claude_session_id: `sid-${id}`, model: 'claude-haiku-4-5', total_cost_usd: usd, closed_at: at,
                } as never)
                .execute();
        };
        await agentRun('r1', 'R', 2, '2026-10-11T00:00:00Z');
        await agentRun('r2', null, 1, '2026-10-12T00:00:00Z');
        await agentRun('r-test', 'TT', 50, '2026-10-12T00:00:00Z');
        await agentRun('r-err', 'R', 50, '2026-10-12T00:00:00Z', 'error');
        await agentRun('r-old', 'R', 50, '2026-10-01T00:00:00Z');
        await session('s1', 0.5, '2026-10-11T12:00:00Z');
        await session('s-open', 50, '2026-10-11T12:00:00Z', 'active');

        const a = await analytics({ tz: 'UTC', window: '7d', now: NOW });
        expect(a.spend_usd).toBeCloseTo(3.5, 9);
        const by = Object.fromEntries(a.series.map((b) => [b.bucket, b.spend_usd]));
        expect(by['2026-10-11']).toBeCloseTo(2.5, 9);
        expect(by['2026-10-12']).toBeCloseTo(1, 9);
        expect(by['2026-10-13']).toBe(0);
    });
});
