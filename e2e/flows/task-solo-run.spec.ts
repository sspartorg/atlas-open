import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet, closeTask, taskRuns } from '../helpers/api.js';
import { sql } from '../helpers/db.js';

// One Task, one agent, end to end: a Task created with an agent from
// /tasks/new is queued, dispatch starts its run at once, the run shows on the
// Task's rail and opens on /runs/:runId. AI is off in e2e, so the agent's step
// is a simulated pass; the seeded project has no credential, so delivery's
// push is refused and the run parks waiting for the Owner.

const TITLE = `E2E solo run ${Date.now()}`;
let taskId = '';

test.afterAll(async ({ request }) => {
    if (!taskId) return;
    await closeTask(request, taskId);
    await request.delete(`${API}/api/tasks/${taskId}`);
});

test('a Task created with an agent runs, shows its run on the rail, and opens on /runs/:runId', async ({ page, request }) => {
    test.setTimeout(120_000);
    const agent = (await apiGet<Array<{ id: string; name: string }>>(request, '/api/agents')).find((a) => a.id === SEEDED_AGENT);
    expect(agent, `${SEEDED_AGENT} installed by the seed`).toBeTruthy();
    const agentName = agent!.name;

    await goto(page, '/tasks/new?project=e2e-terminal-project');
    await page.getByLabel('Title').fill(TITLE);
    await page.getByLabel('Description').fill('Made by task-solo-run.spec.');
    await page.getByRole('combobox', { name: 'Agent' }).click();
    await page.getByRole('option', { name: new RegExp(agentName) }).click();
    await page.getByRole('button', { name: 'Submit' }).first().click();

    await page.waitForURL(/\/tasks\/ETM-\d+$/);
    taskId = /ETM-\d+/.exec(page.url())?.[0] ?? '';
    await expect(page.getByText(`Submitted — ${agentName} is starting`)).toBeVisible();
    const task = await apiGet<{ assignee_agent_id: string | null; status: string }>(request, `/api/tasks/${taskId}`);
    expect(task.assignee_agent_id).toBe(SEEDED_AGENT);
    expect(task.status).not.toBe('draft');

    // Dispatch starts the run; the simulated step passes and delivery parks it.
    // A Task that never starts is a blocked one: say what held it.
    await expect
        .poll(async () => (await taskRuns(request, taskId))[0]?.status, { timeout: 60_000, intervals: [1_000] })
        .toBe('waiting_for_owner')
        .catch(async (err: Error) => {
            const queue = JSON.stringify(await apiGet(request, '/api/queue'));
            const live = JSON.stringify(sql(`SELECT id, item_id, status, park_reason FROM workflow_runs WHERE status IN ('running', 'waiting_for_owner')`));
            const itemless = JSON.stringify(sql(`SELECT id, agent_id, status FROM agent_runs WHERE status IN ('queued', 'in_progress') AND workflow_run_id IS NULL`));
            throw new Error(`${err.message}\nqueue: ${queue}\nlive runs: ${live}\nlive itemless runs: ${itemless}`);
        });
    const [run] = await taskRuns(request, taskId);
    expect(run!.park_reason).toMatch(/credential/);
    await expect.poll(async () => (await apiGet<{ status: string }>(request, `/api/tasks/${taskId}`)).status).toBe('waiting_for_info');

    // The Task's rail: its Agent and the run panel.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Agent\b/ })).toContainText(agentName);
    const runLink = page.locator(`a[href="/runs/${run!.id}"]`);
    await expect(runLink).toContainText('Waiting for you');
    await expect(page.getByText(run!.park_reason!).first()).toBeVisible();

    // The run page.
    await runLink.click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run!.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
    await expect(page.getByText('The run is waiting for you.')).toBeVisible();
    const steps = page.getByRole('region', { name: 'Steps' });
    await expect(steps).toContainText('Steps · 1');
    await expect(steps).toContainText(agentName);
    await expect(steps).toContainText('outcome: done');
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(page.getByRole('link', { name: taskId }).first()).toHaveAttribute('href', `/tasks/${taskId}`);

    // Resume retries delivery; still no credential, so it parks again.
    const resumed = page.waitForResponse((r) => r.url().endsWith(`/api/workflow-runs/${run!.id}/resume`));
    await page.getByRole('button', { name: 'Resume' }).click();
    expect((await resumed).ok()).toBe(true);
    await expect
        .poll(async () => (await taskRuns(request, taskId))[0]?.status, { timeout: 60_000, intervals: [1_000] })
        .toBe('waiting_for_owner');

    // Stop ends it for good: no Resume, no Stop.
    await page.reload();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(async () => (await taskRuns(request, taskId))[0]?.status, { timeout: 30_000 }).toBe('cancelled');
    await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
});
