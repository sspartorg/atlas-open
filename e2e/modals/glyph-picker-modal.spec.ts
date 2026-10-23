import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';

// GlyphPickerModal opens from the Glyph row ("Replace…") of the Identity panel
// in the Agent Detail sidebar (AgentSidebar). The e2e seed installs Solo
// Engineer. We never submit — Cancel or Esc only.

test.describe('GlyphPickerModal', () => {
    test.beforeEach(async ({ page }) => {
        await goto(page, '/agents/agent-solo');
        await page.getByRole('button', { name: 'Replace glyph' }).click();
    });

    test('opens from the sidebar with a grid of glyph choices, closes with Cancel', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: 'Replace glyph' });
        await expect(dialog).toBeVisible();
        // Exactly one glyph tile is pressed: the agent's current glyph.
        await expect(dialog.locator('[role="button"][aria-pressed="true"]')).toHaveCount(1);
        expect(await dialog.locator('[role="button"][aria-pressed]').count()).toBeGreaterThan(1);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    test('closes with Esc', async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: 'Replace glyph' });
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
    });
});
