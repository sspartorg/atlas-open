import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { one } from '../helpers/db.js';

// AddFromMarketplaceModal opens from "Add to my agents" on the marketplace
// detail page, shown only for a catalog agent that is not installed. The e2e
// seed installs only agent-solo, so AI News is a catalog-only entry.
// We never install — Cancel or Esc only.

const AGENT = 'agent-ai-news';

test.describe('AddFromMarketplaceModal', () => {
    test.beforeEach(async ({ page }) => {
        expect(one(`SELECT count(*) FROM agents WHERE id = '${AGENT}'`)).toBe('0');
        await goto(page, `/agents/marketplace/${AGENT}`);
        await page.getByRole('button', { name: 'Add to my agents' }).click();
    });

    test('opens with the catalog slug and closes with Cancel', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: /to your agents$/ });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('local slug')).toBeVisible();
        await expect(dialog.getByText(AGENT, { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    test('closes with Esc and installs nothing', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: /to your agents$/ });
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('button', { name: 'Add to my agents' })).toBeVisible();
        expect(one(`SELECT count(*) FROM agents WHERE id = '${AGENT}'`)).toBe('0');
    });
});
