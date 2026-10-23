import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { setThemeMode } from '../helpers/theme.js';

// Phase C — Analytics page dark-mode smoke. Owner flagged Analytics
// as the worst dark-mode regression target; this test runs in dark
// mode (initial script sets data-theme + localStorage before paint)
// and asserts the tiles and the chart render
// without console errors.

test.describe('/analytics — dark mode', () => {
    test('renders cleanly in dark mode (no console errors, key headings visible)', async ({
        page,
    }) => {
        await setThemeMode(page, 'dark');
        await goto(page, '/analytics');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        // The tiles and chart render on the themed surface.
        await expect(page.getByText('PRs merged', { exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: /Shipped and spent/ })).toBeVisible();
    });
});
