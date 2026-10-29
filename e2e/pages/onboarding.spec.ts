import { test, expect } from '@playwright/test';

// /onboarding e2e isolation tests.
//
// The e2e seed sets settings.onboarding_complete=1 so the App.tsx
// route guard redirects /onboarding → / for every test that doesn't
// want to see the onboarding UI. These three tests use the narrow
// test-only endpoint POST /api/settings/test/clear-onboarding to
// flip that flag back to 0 before navigating, and restore it via
// POST /api/settings/onboard in afterEach.
//
// ATLAS_MCP_TOKEN is unset in the e2e environment, so both endpoints
// are fully open. The `request` fixture is Node-side; relative URLs
// work because the e2e API is bound to http://127.0.0.1:7001.

import { API, apiGet } from '../helpers/api.js';

test.describe('/onboarding', () => {
    test.afterEach(async ({ request }) => {
        // Restore onboarding_complete so the route guard works normally
        // for subsequent specs that navigate to seeded pages.
        // onboard() now mkdirs the path, so it must be writable on every OS.
        const res = await request.post(`${API}/api/settings/onboard`, {
            data: { owner_name: 'Owner', workspace_path: '/tmp/atlas-open-e2e' },
        });
        expect(res.ok()).toBe(true);
    });

    test('Step 1: welcome heading, step indicator, and Next button are visible', async ({
        page,
        request,
    }) => {
        await request.post(`${API}/api/settings/test/clear-onboarding`);

        await page.goto('/onboarding', { waitUntil: 'load' });

        await expect(page.getByText('Welcome to Atlas.')).toBeVisible();
        await expect(page.getByText('Step 1 of 2')).toBeVisible();
        await expect(page.getByRole('button', { name: /next/i })).toBeVisible();
    });

    test('Step 2: filling display name and pressing Next shows Step 2 of 2', async ({
        page,
        request,
    }) => {
        await request.post(`${API}/api/settings/test/clear-onboarding`);

        await page.goto('/onboarding', { waitUntil: 'load' });

        await page.getByLabel(/display name/i).fill('E2E Tester');
        await page.getByRole('button', { name: /next/i }).click();

        await expect(page.getByText('Step 2 of 2')).toBeVisible();
    });

    test('Step 2: Finish Setup button is visible after advancing from Step 1', async ({
        page,
        request,
    }) => {
        await request.post(`${API}/api/settings/test/clear-onboarding`);

        await page.goto('/onboarding', { waitUntil: 'load' });

        await page.getByLabel(/display name/i).fill('E2E Tester');
        await page.getByRole('button', { name: /next/i }).click();

        await expect(page.getByRole('button', { name: /finish setup/i })).toBeVisible();
        // Do NOT click — clicking would call POST /api/settings/onboard
        // which navigates away after a 5 s success view; afterEach will
        // restore the flag cleanly instead.
    });

    test('Finish Setup saves the name and workspace, then lands on the dashboard', async ({
        page,
        request,
    }) => {
        // Finish writes owner_name, workspace_path and accent_color; put back
        // exactly what was there so later specs see the seeded settings.
        const before = await apiGet<Settings>(request, '/api/settings');
        try {
            await request.post(`${API}/api/settings/test/clear-onboarding`);
            await page.goto('/onboarding', { waitUntil: 'load' });
            await page.getByLabel(/display name/i).fill('E2E Finisher');
            await page.getByRole('button', { name: /next/i }).click();
            // The seeded workspace, so Finish creates no new folder.
            await page.getByLabel('Workspace folder').fill(before.workspace_path);
            await page.getByRole('button', { name: /finish setup/i }).click();

            await expect(page.getByText("You're all set.")).toBeVisible();
            await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
            const after = await apiGet<Settings>(request, '/api/settings');
            expect(after.owner_name).toBe('E2E Finisher');
            expect(after.workspace_path).toBe(before.workspace_path);
            expect(after.onboarding_complete).toBeTruthy();
            // Onboarded: /onboarding now redirects home.
            await page.goto('/onboarding', { waitUntil: 'load' });
            await expect(page).toHaveURL(/\/$/);
        } finally {
            await request.patch(`${API}/api/settings/profile`, { data: { accent_color: before.accent_color } });
            await request.post(`${API}/api/settings/onboard`, {
                data: { owner_name: before.owner_name, workspace_path: before.workspace_path },
            });
        }
    });
});

interface Settings {
    owner_name: string;
    workspace_path: string;
    accent_color: string;
    onboarding_complete: number | boolean;
}
