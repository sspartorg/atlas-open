import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet, closeTask, createTask } from '../helpers/api.js';

// ADR 0033 — one slot, one queue. A schedule on the seeded agent holds its
// Task back ("Waits for schedule"), which makes the waiting state stable
// enough to assert on; turning the schedule off lets dispatch start it.

interface Queue {
    slots: number;
    running: Array<{ id: string }>;
    waiting: Array<{ id: string; blocked_reason: string | null }>;
    scheduled: Array<{ agent_id: string }>;
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.afterEach(async ({ request }) => {
    await request.patch(`${API}/api/agents/${SEEDED_AGENT}`, { data: { schedule_enabled: false } });
});

test('a scheduled agent holds its Task in the queue until the schedule allows it', async ({ page, request }) => {
    const on = await request.patch(`${API}/api/agents/${SEEDED_AGENT}`, {
        data: { schedule_enabled: true, schedule_preset: 'weekly', schedule_weekday: 0, schedule_time_of_day: '03:00' },
    });
    expect(on.status(), await on.text()).toBe(200);
    const task = await createTask(request, 'Queue e2e: waits for schedule', SEEDED_AGENT);

    try {
        await expect
            .poll(async () => (await apiGet<Queue>(request, '/api/queue')).waiting.find((w) => w.id === task.id)?.blocked_reason)
            .toBe('awaiting_schedule');

        await goto(page, '/queue');
        await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
        await expect(page.getByText('Running now · 0 / 1')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Queue e2e: waits for schedule' })).toBeVisible();
        await expect(page.getByText('Waits for schedule', { exact: true })).toBeVisible();
        await expect(page.getByText('0 3 * * 0')).toBeVisible();

        // Schedule off: the Task is next in line and dispatch takes it.
        await request.patch(`${API}/api/agents/${SEEDED_AGENT}`, { data: { schedule_enabled: false } });
        await expect
            .poll(async () => (await apiGet<Queue>(request, '/api/queue')).waiting.some((w) => w.id === task.id), { timeout: 70_000 })
            .toBe(false);
    } finally {
        await closeTask(request, task.id);
    }
});

test('an agent that runs on its own cannot be given a Task', async ({ request }) => {
    await request.patch(`${API}/api/agents/${SEEDED_AGENT}`, { data: { requires_item: false } });
    try {
        const res = await request.post(`${API}/api/tasks`, {
            data: { project_id: 'e2e-terminal-project', title: 'Queue e2e: refused', assignee_agent_id: SEEDED_AGENT },
        });
        expect(res.status()).toBe(400);
    } finally {
        await request.patch(`${API}/api/agents/${SEEDED_AGENT}`, { data: { requires_item: true } });
    }
});
