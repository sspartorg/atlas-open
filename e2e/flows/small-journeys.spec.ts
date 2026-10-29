import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, apiGet, apiPost } from '../helpers/api.js';

// Three short journeys the page specs only open: a Scratch pad tile that
// autosaves and is deleted, a Search hit that opens its Task, and the history
// page of a stopped Terminal session showing its transcript.

test('Scratch pad: a new tile autosaves, keeps an inferred title, and deletes', async ({ page, request }) => {
    const words = `Spad${Date.now()} remember the milk`;
    const title = words.split(' ').slice(0, 3).join(' ');
    let tileId = '';
    try {
        await goto(page, '/scratch-pad');
        await page.getByRole('button', { name: /new tile/i }).first().click();
        const editor = page.getByRole('dialog');
        await editor.getByPlaceholder('Take a note...').fill(words);
        // Autosave fires 5s after the last keystroke.
        await expect(editor.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });
        const tile = (await apiGet<Array<{ id: string; title: string; body_md: string }>>(request, '/api/scratch-pad')).find((t) => t.body_md === words);
        expect(tile?.title).toBe(title);
        tileId = tile!.id;

        await page.reload();
        await page.getByText(title, { exact: true }).click();
        await expect(page.getByRole('dialog').getByPlaceholder('Take a note...')).toHaveValue(words);
        await page.getByRole('button', { name: 'Delete tile' }).click();
        await page.getByRole('dialog').last().getByRole('button', { name: /^Delete / }).click();
        await expect(page.getByText(title, { exact: true })).toHaveCount(0);

        await page.reload();
        await expect(page.getByRole('heading', { name: 'Scratch Pad', exact: true })).toBeVisible();
        await expect(page.getByText(title, { exact: true })).toHaveCount(0);
        expect((await request.get(`${API}/api/scratch-pad/${tileId}`)).status()).toBe(404);
        tileId = '';
    } finally {
        if (tileId) await request.delete(`${API}/api/scratch-pad/${tileId}`);
    }
});

test('Search: a seeded Task is found and its hit opens the Task', async ({ page }) => {
    await goto(page, '/search');
    await page.getByLabel(/Search by title, description, or ID/i).fill('E2E linked task');
    await page.getByText(/E2E linked task/).last().click();
    await expect(page).toHaveURL(/\/tasks\/ETM-1$/);
    await expect(page.getByText('E2E linked task').first()).toBeVisible();
});

test('Terminal history: a stopped session shows its transcript', async ({ page, request }) => {
    test.setTimeout(180_000);
    const session = await apiPost<{ id: string }>(request, '/api/cli/sessions', {
        project_id: 'e2e-terminal-project',
        title: 'E2E history transcript',
    });
    try {
        // The row is `active` before the PTY child has booted; fake-claude
        // writes its JSONL transcript just before its "ready" line, so wait
        // for that line in the live terminal before stopping.
        await goto(page, `/terminal/${session.id}`);
        await expect(page.locator('.xterm').first()).toContainText('[fake-claude] ready', { timeout: 30_000 });
        await apiPost(request, `/api/cli/sessions/${session.id}/stop`, { files_to_stage: [], open_pull_request: false });

        await goto(page, `/terminal/${session.id}/history`);
        await expect(page.getByRole('heading', { level: 1, name: 'E2E history transcript' })).toBeVisible();
        await expect(page.getByText('Transcript captured')).toBeVisible();
        // The timeline lists fake-claude's two turns; picking one shows it.
        await expect(page.getByText('[fake] kickoff').first()).toBeVisible();
        await page.getByText('assistant', { exact: true }).first().click();
        await expect(page.getByText(/\[fake\] hello from fake claude/).first()).toBeVisible();
    } finally {
        await request.delete(`${API}/api/cli/sessions/${session.id}`);
    }
});
