import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../routes/events.js', () => ({ eventsRoutes: async () => undefined, broadcastSSE: vi.fn() }));

import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertAgent } from '../../tests/_items.js';
import { installRunConfig, markDueAgents, nextFireAt, queueAgentRun, runConfigColumns, runConfigOf } from './agent-schedules.js';
import { ApiError } from '../utils/errors.js';

const NOW = new Date('2026-10-27T10:30:00Z');
const base = runConfigOf({});

beforeEach(async () => {
    await truncateAll();
    await insertAgent({ id: 'a-task', status: 'active' });
});

afterAll(async () => {
    await closeTestDb();
});

describe('runConfigOf / installRunConfig', () => {
    it('fills the migration defaults', () => {
        expect(base).toEqual({
            requires_item: true,
            git_commit: true,
            git_push: true,
            git_open_pr: true,
            schedule_enabled: false,
            schedule_preset: 'daily',
            schedule_time_of_day: '09:00',
            schedule_weekday: null,
            schedule_cron_expression: '0 9 * * *',
        });
    });

    it('computes the next fire only when the catalog ships the schedule on', () => {
        expect(installRunConfig({}).schedule_next_run_at).toBeNull();
        const on = installRunConfig({ schedule_enabled: true, schedule_cron_expression: '0 * * * *' }, NOW);
        expect(on.schedule_next_run_at).toBe(nextFireAt('0 * * * *', NOW));
    });
});

describe('runConfigColumns', () => {
    it('writes nothing for a patch without run config', () => {
        expect(runConfigColumns(base, {})).toEqual({});
    });

    it('passes git flags through when the merged chain holds', () => {
        expect(runConfigColumns(base, { git_open_pr: false })).toEqual({ git_open_pr: false });
    });

    it('rejects a patch that breaks the chain against the stored row', () => {
        const stored = { ...base, git_commit: false, git_push: false, git_open_pr: false };
        expect(() => runConfigColumns(stored, { git_push: true })).toThrow(ApiError);
        expect(() => runConfigColumns(base, { git_commit: false })).toThrow('git_push needs git_commit');
    });

    it('materialises the cron and the next fire when the schedule turns on', () => {
        const out = runConfigColumns(base, { schedule_enabled: true, schedule_preset: 'weekly', schedule_weekday: 1, schedule_time_of_day: '08:15' }, NOW);
        expect(out.schedule_cron_expression).toBe('15 8 * * 1');
        expect(out.schedule_next_run_at).toBe(nextFireAt('15 8 * * 1', NOW));
        expect(out).not.toHaveProperty('schedule_due_at');
    });

    it('clears the next fire and any pending fire when the schedule turns off', () => {
        const out = runConfigColumns({ ...base, schedule_enabled: true }, { schedule_enabled: false }, NOW);
        expect(out).toMatchObject({ schedule_next_run_at: null, schedule_due_at: null, schedule_cron_expression: '0 9 * * *' });
    });

    it('turns a bad custom cron into a 400', () => {
        expect(() => runConfigColumns(base, { schedule_preset: 'custom', schedule_cron_expression: 'not a cron' })).toThrow(ApiError);
    });

    it('works with no stored row (create) and falls back to the defaults', () => {
        expect(runConfigColumns(undefined, { schedule_enabled: true }, NOW)).toMatchObject({
            schedule_cron_expression: '0 9 * * *',
            schedule_next_run_at: nextFireAt('0 9 * * *', NOW),
        });
    });
});

describe('markDueAgents', () => {
    const agent = (id: string) => testDb.selectFrom('agents').select(['schedule_next_run_at', 'schedule_due_at']).where('id', '=', id).executeTakeFirstOrThrow();
    const waitingRuns = (id: string) =>
        testDb.selectFrom('agent_runs').select('id').where('agent_id', '=', id).where('status', '=', 'queued').where('started_at', 'is', null).execute();

    beforeEach(async () => {
        await insertAgent({ id: 'a-free', status: 'active' });
        await insertAgent({ id: 'a-off', status: 'inactive' });
        const past = new Date(NOW.getTime() - 60_000).toISOString();
        await testDb.updateTable('agents').set({ schedule_enabled: true, schedule_cron_expression: '0 * * * *', schedule_next_run_at: past }).execute();
        await testDb.updateTable('agents').set({ requires_item: false }).where('id', '=', 'a-free').execute();
    });

    it('marks a Task agent due, queues an itemless run, and advances both', async () => {
        expect(await markDueAgents(NOW)).toBe(2);
        const task = await agent('a-task');
        expect(new Date(task.schedule_due_at ?? '').getTime()).toBe(NOW.getTime() - 60_000);
        expect(new Date(task.schedule_next_run_at ?? '').toISOString()).toBe(nextFireAt('0 * * * *', NOW));
        expect((await agent('a-free')).schedule_due_at).toBeNull();
        expect(await waitingRuns('a-free')).toHaveLength(1);
        expect(await waitingRuns('a-off')).toHaveLength(0);
    });

    it('collapses missed fires: one pending fire, one waiting run', async () => {
        await markDueAgents(NOW);
        const first = (await agent('a-task')).schedule_due_at;
        await testDb.updateTable('agents').set({ schedule_next_run_at: NOW.toISOString() }).execute();
        expect(await markDueAgents(new Date(NOW.getTime() + 1000))).toBe(2);
        expect((await agent('a-task')).schedule_due_at).toEqual(first);
        expect(await waitingRuns('a-free')).toHaveLength(1);
    });

    it('does nothing before the next fire', async () => {
        expect(await markDueAgents(new Date(NOW.getTime() - 3_600_000))).toBe(0);
    });
});

describe('queueAgentRun', () => {
    it('queues a separate run when asked not to collapse', async () => {
        const a = await queueAgentRun('a-task', { collapse: false, projectId: null });
        const b = await queueAgentRun('a-task', { collapse: false });
        expect(a).not.toBe(b);
        expect([a, b]).toContain(await queueAgentRun('a-task'));
    });
});
