import { test, expect } from '@playwright/test';

// The API down (Docker stopped, API crashed or still booting) is not a new
// install: every page used to redirect to the onboarding wizard and lose its
// URL. Now the page says the API is unreachable, keeps its URL, and comes
// back by itself once the API answers again.
test('API unreachable: the page says so, keeps its URL, and recovers on its own', async ({ page }) => {
    let down = true;
    // Only API calls — Vite serves the app's own modules under /src/api/.
    await page.route(
        (u) => u.pathname.startsWith('/api/'),
        (r) => (down ? r.fulfill({ status: 500, body: '' }) : r.continue()),
    );
    await page.goto('/tasks/ETM-1');
    await expect(page.getByRole('heading', { name: "Atlas can't reach its API" })).toBeVisible();
    await expect(page).toHaveURL(/\/tasks\/ETM-1$/);

    down = false;
    await expect(page.getByText('E2E linked task').first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/tasks\/ETM-1$/);
});
