import { test, expect, type Page } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, apiGet } from '../helpers/api.js';

// An agent's whole life through the UI: Add Agent on /agents, edit its
// configuration, prompt and memory on its detail page, pause and resume it,
// duplicate it and delete it. Every step reloads or reads the API to prove
// the change persisted, not just that the page showed it.

interface Agent {
    id: string;
    name: string;
    model: string;
    effort: string;
    status: 'active' | 'inactive';
    prompt_md: string;
    prompt_version: number;
}

const NAME = `E2E Lifecycle ${Date.now()}`;
const created: string[] = [];

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.afterAll(async ({ request }) => {
    for (const id of created) await request.delete(`${API}/api/agents/${id}`);
});

const agentByName = async (page: Page, name: string) =>
    (await apiGet<Agent[]>(page.request, '/api/agents')).find((a) => a.name === name);
const agent = (page: Page, id: string) => apiGet<Agent>(page.request, `/api/agents/${id}`);
const id = () => created[0]!;

/** The detail page's hero menu (more_vert) → `item`. */
async function heroMenu(page: Page, item: string) {
    await page.locator('.material-symbols-rounded', { hasText: 'more_vert' }).first().click();
    await page.getByRole('menuitem', { name: item }).click();
}

test('Add Agent creates a card that survives a reload', async ({ page }) => {
    await goto(page, '/agents');
    await page.getByRole('button', { name: 'Add Agent' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Agent' });
    await dialog.getByLabel('Agent name').fill(NAME);
    await dialog.getByRole('button', { name: 'Add Agent' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(NAME, { exact: true })).toBeVisible();

    const row = await agentByName(page, NAME);
    expect(row, 'the agent the dialog created').toBeTruthy();
    created.push(row!.id);

    await page.reload();
    await expect(page.getByText(NAME, { exact: true })).toBeVisible();
});

test('Overview: a new model and effort are saved and survive a reload', async ({ page }) => {
    const before = await agent(page, id());
    await goto(page, `/agents/${id()}`);
    const combo = (label: string) =>
        page.getByText(label, { exact: true }).locator('xpath=following-sibling::div').getByRole('combobox');

    await combo('Effort').click();
    await page.getByRole('option', { name: 'high', exact: true }).click();
    await combo('Model').click();
    await page.getByRole('option', { selected: false }).first().click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('No changes')).toBeVisible();

    await page.reload();
    await expect(combo('Effort')).toHaveText('high');
    const after = await agent(page, id());
    expect(after.effort).toBe('high');
    expect(after.model).not.toBe(before.model);
});

test('Prompt: a save makes a new version and Revert brings back v1', async ({ page }) => {
    const v1 = await agent(page, id());
    await goto(page, `/agents/${id()}`);
    await page.getByRole('tab', { name: 'Prompt' }).click();
    const editor = page.locator('textarea').first();
    await editor.fill('# Lifecycle\n\nEdited by agent-lifecycle.spec.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`Active prompt · v${v1.prompt_version + 1}`)).toBeVisible();

    await page.reload();
    await expect(editor).toHaveValue('# Lifecycle\n\nEdited by agent-lifecycle.spec.');
    expect((await agent(page, id())).prompt_version).toBe(v1.prompt_version + 1);

    // The v1 row of Version history: its Revert link.
    const v1Row = page
        .locator('div')
        .filter({ has: page.getByText('v1', { exact: true }) })
        .filter({ has: page.getByText('Revert', { exact: true }) })
        .last();
    await v1Row.getByText('Revert', { exact: true }).click();
    await expect(page.getByText(`Active prompt · v${v1.prompt_version + 2}`)).toBeVisible();

    await page.reload();
    await expect(editor).toHaveValue(v1.prompt_md);
    expect((await agent(page, id())).prompt_md).toBe(v1.prompt_md);
});

test('Memory: an edit is saved and survives a reload', async ({ page }) => {
    await goto(page, `/agents/${id()}`);
    await page.getByRole('tab', { name: 'Memory' }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox').last().fill('Remember: agent-lifecycle.spec was here.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText('Remember: agent-lifecycle.spec was here.')).toBeVisible();
    const memory = await apiGet<{ body_md: string }>(page.request, `/api/agents/${id()}/memory`);
    expect(memory.body_md).toBe('Remember: agent-lifecycle.spec was here.');
});

test('Pause then Resume flips the status and it sticks', async ({ page }) => {
    await goto(page, `/agents/${id()}`);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
    expect((await agent(page, id())).status).toBe('inactive');

    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    expect((await agent(page, id())).status).toBe('active');
});

test('Duplicate makes a new agent with the same prompt', async ({ page }) => {
    const source = await agent(page, id());
    await goto(page, `/agents/${id()}`);
    await heroMenu(page, 'Duplicate');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Duplicate agent' }).click();
    await dialog.getByRole('button', { name: /Open duplicate/ }).click();

    await expect(page).not.toHaveURL(new RegExp(`/agents/${id()}$`));
    const copyId = /\/agents\/([^/?]+)$/.exec(page.url())?.[1] ?? '';
    expect(copyId).not.toBe('');
    created.push(copyId);
    const copy = await agent(page, copyId);
    expect(copy.prompt_md).toBe(source.prompt_md);
    expect(copy.name).not.toBe(source.name);
});

test('Delete removes the agent from /agents', async ({ page }) => {
    await goto(page, `/agents/${id()}`);
    await heroMenu(page, 'Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete agent' }).click();
    await expect(page).toHaveURL(/\/agents$/);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Add Agent' }).first()).toBeVisible();
    await expect(page.getByText(NAME, { exact: true })).toHaveCount(0);
    expect((await page.request.get(`${API}/api/agents/${id()}`)).status()).toBe(404);
});
