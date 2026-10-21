import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet, closeTask, taskRuns } from '../helpers/api.js';

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
    await expect.poll(async () => (await taskRuns(request, taskId))[0]?.status, { timeout: 60_000, intervals: [1_000] }).toBe('waiting_for_owner');
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
});
