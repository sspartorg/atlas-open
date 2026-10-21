import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';

test.describe('/agents', () => {
    test('renders without console errors', async ({ page }) => {
        await goto(page, '/agents');
        await expect(page.getByRole('heading', { name: /Agents/i }).first()).toBeVisible();
    });

    test('shows the seeded Solo Engineer agent card', async ({ page }) => {
        await goto(page, '/agents');
        await expect(page.getByText(/Solo Engineer/i).first()).toBeVisible();
        // Cards list CLI · Model · Effort.
        await expect(page.getByText('Effort', { exact: true }).first()).toBeVisible();
    });

    test('clicking an agent card navigates to its detail page', async ({ page }) => {
        await goto(page, '/agents');
        const card = page.getByText(/Solo Engineer/i).first();
        await card.click();
        await expect(page).toHaveURL(/\/agents\/[a-z0-9-]+/);
    });
});
