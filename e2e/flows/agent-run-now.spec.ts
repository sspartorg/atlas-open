import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet } from '../helpers/api.js';

// Run now on an agent's detail page starts a project-level run (no Task) and
// opens /agents/:id/runs/:runId. AI is off in e2e, so the run is a simulated
// pass that completes on its own; its log then downloads as `<id8>.log`.

interface Run {
    status: string;
    output_text: string | null;
}

let runId = '';

test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`${API}/api/run/${runId}`);
});

test('Run now opens the run, it completes, and its log downloads', async ({ page, request }) => {
    test.setTimeout(120_000);
    await goto(page, `/agents/${SEEDED_AGENT}`);
    await page.getByRole('button', { name: 'Run now' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Run now' }).click();

    await expect(page).toHaveURL(new RegExp(`/agents/${SEEDED_AGENT}/runs/[^/]+$`));
    runId = page.url().split('/').pop()!;

    await expect
        .poll(async () => (await apiGet<Run>(request, `/api/run/${runId}`)).status, { timeout: 90_000, intervals: [1_000] })
        .toBe('completed');
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download log' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${runId.slice(0, 8)}.log`);
    const { output_text } = await apiGet<Run>(request, `/api/run/${runId}`);
    expect(readFileSync((await file.path())!, 'utf8')).toBe(output_text);
});
