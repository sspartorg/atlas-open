import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';

// EditAgentColorModal opens from the Color row of the Identity panel in the
// Agent Detail sidebar (AgentSidebar). The e2e seed installs Solo Engineer.
// We never submit — Cancel or Esc only.

test.describe('EditAgentColorModal', () => {
    test.beforeEach(async ({ page }) => {
        await goto(page, '/agents/agent-solo');
        await page.getByRole('button', { name: 'Edit accent color' }).click();
    });

    test('opens from the sidebar color swatch and closes with Cancel', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: 'Edit accent color' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    test('closes with Esc', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: 'Edit accent color' });
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
    });
});
