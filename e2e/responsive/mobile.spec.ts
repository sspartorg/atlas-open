import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';

// Runs under the `mobile-chrome` Playwright project (390×844, hasTouch).
// Every test title contains `@mobile` so the project's grep filter picks them up.

test.describe('mobile responsive @mobile', () => {
    test('BottomNav renders 4 labels @mobile', async ({ page }) => {
        await goto(page, '/');
        // The BottomNav (`<Box component="nav">`) renders 4 BottomNavigationActions.
        // MUI's BottomNavigationAction renders as <button> but the label-as-text
        // pattern matches the existing unit test pattern (BottomNav.test.tsx).
        for (const label of ['Home', 'Projects', 'Tasks', 'More']) {
            await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
    });

    test('tapping Tasks navigates to /tasks @mobile', async ({ page }) => {
        await goto(page, '/');
        await page.getByText('Tasks', { exact: true }).first().click();
        await expect(page).toHaveURL(/\/tasks/);
    });

    test('tapping Projects navigates to /projects @mobile', async ({ page }) => {
        await goto(page, '/');
        await page.locator('.MuiBottomNavigation-root').getByRole('button', { name: 'Projects' }).click();
        await expect(page).toHaveURL(/\/projects$/);
    });

    test('More tab opens MoreSheet @mobile', async ({ page }) => {
        await goto(page, '/');
        await page.getByText('More', { exact: true }).first().click();
        // MoreSheet is an MUI Drawer rendered with role="presentation".
        await expect(page.getByRole('presentation').first()).toBeVisible();
    });
});
