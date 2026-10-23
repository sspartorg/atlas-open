import { test, expect, type Page } from '@playwright/test';
import { goto } from '../helpers/nav.js';

// ShortcutsDialog is opened by useGlobalShortcuts (Ctrl/Cmd+K and "?") and by
// the "Shortcuts" pill in the Topbar (desktop widths only).

async function expectShortcutsDialog(page: Page) {
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Keyboard Shortcuts', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Ctrl', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
}

test.describe('ShortcutsDialog', () => {
    test.beforeEach(async ({ page }) => {
        await goto(page, '/');
    });

    test('Ctrl+K opens it and Esc closes it', async ({ page }) => {
        await page.keyboard.press('Control+k');
        await expectShortcutsDialog(page);
    });

    test('Meta+K opens it', async ({ page }) => {
        await page.keyboard.press('Meta+k');
        await expectShortcutsDialog(page);
    });

    test('? opens it', async ({ page }) => {
        await page.keyboard.press('Shift+?');
        await expectShortcutsDialog(page);
    });

    test('the Topbar Shortcuts pill opens it', async ({ page }) => {
        await page.getByRole('button', { name: 'Shortcuts' }).click();
        await expectShortcutsDialog(page);
    });
});
