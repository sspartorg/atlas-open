import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet, apiPost } from '../helpers/api.js';
import { one, sql } from '../helpers/db.js';

// ADR 0033 — one slot. A Run now while the slot is taken waits in the queue,
// and the Owner can cancel it from /queue before it ever starts. The slot is
// held by an in-progress itemless run row written straight to the DB: a real
// simulated run finishes in seconds, too soon to cancel anything behind it.

interface Queue {
    running: Array<{ id: string }>;
    waiting: Array<{ id: string }>;
}

let blocker = '';
let runId = '';

test.afterAll(async ({ request }) => {
    if (blocker) sql(`DELETE FROM agent_runs WHERE id = '${blocker}'`);
    if (runId) await request.delete(`${API}/api/run/${runId}`);
});

test('a queued Run now is cancelled from /queue and leaves it', async ({ page, request }) => {
    blocker = one(
        `INSERT INTO agent_runs (id, agent_id, status, started_at) VALUES (gen_random_uuid()::text, '${SEEDED_AGENT}', 'in_progress', now()) RETURNING id`,
    );
    ({ runId } = await apiPost<{ runId: string }>(request, '/api/run', { agent_id: SEEDED_AGENT }));
    await expect.poll(async () => (await apiGet<Queue>(request, '/api/queue')).waiting.map((w) => w.id)).toContain(runId);

    await goto(page, '/queue');
    await expect(page.getByText('Running now · 1 / 1')).toBeVisible();
    await expect(page.getByText('Waiting · 1')).toBeVisible();
    const waiting = page.locator('li').filter({ has: page.getByRole('button', { name: 'Cancel' }) });
    await expect(waiting).toHaveCount(1);
    await waiting.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
    expect((await apiGet<Queue>(request, '/api/queue')).waiting.map((w) => w.id)).not.toContain(runId);
    expect((await apiGet<{ status: string }>(request, `/api/run/${runId}`)).status).toBe('cancelled');
    await page.reload();
    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
});
