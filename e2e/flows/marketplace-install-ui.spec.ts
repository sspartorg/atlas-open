import { test, expect, type Page } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, apiGet } from '../helpers/api.js';
import { one } from '../helpers/db.js';

// Installing a catalog agent from the /agents/marketplace grid: the card's
// Add opens AddFromMarketplaceModal, "Add to my agents" installs it and lands
// on the new agent. Back on the grid the card says Installed, and /agents
// lists it. The e2e seed installs only agent-solo, so AI News starts as a
// catalog-only entry; the test removes it again so that stays true.

const AGENT = 'agent-ai-news';

test.afterEach(async ({ request }) => {
    await request.delete(`${API}/api/agents/${AGENT}`);
});

/** The marketplace card holding `name` and `has` (innermost such div). */
const card = (page: Page, name: string, has: ReturnType<Page['getByText']>) =>
    page.locator('div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has }).last();

test('Add on a marketplace card installs the agent', async ({ page, request }) => {
    expect(one(`SELECT count(*) FROM agents WHERE id = '${AGENT}'`)).toBe('0');
    const { agent } = await apiGet<{ agent: { name: string } }>(request, `/api/marketplace/agents/${AGENT}`);

    await goto(page, '/agents/marketplace');
    await card(page, agent.name, page.getByRole('button', { name: 'Add', exact: true }))
        .getByRole('button', { name: 'Add', exact: true })
        .click();
    const dialog = page.getByRole('dialog', { name: `Add ${agent.name} to your agents` });
    await dialog.getByRole('button', { name: 'Add to my agents' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${AGENT}$`));

    await goto(page, '/agents/marketplace');
    await expect(card(page, agent.name, page.getByText('Installed', { exact: true }))).toBeVisible();
    const entry = (await apiGet<Array<{ id: string; is_installed: boolean }>>(request, '/api/marketplace/agents')).find((a) => a.id === AGENT);
    expect(entry?.is_installed).toBe(true);

    await goto(page, '/agents');
    await expect(page.getByText(agent.name, { exact: true })).toBeVisible();
});
