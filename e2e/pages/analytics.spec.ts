import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { goto } from '../helpers/nav.js';
import { routeAnalytics } from '../fixtures/analytics-fixtures.js';

// /analytics — four numbers and one chart over one window (`?window=`). The e2e
// DB is too small to draw a real chart, so the endpoint is routed to a
// realistic fixture (e2e/fixtures/analytics-fixtures.ts) except where noted.

const TILES = ['Tasks shipped', 'PRs merged', 'Median cycle time', 'Spend'];
const CHART = /^Shipped and spent, per/;

test.describe('/analytics', () => {
    test('shows the four tiles and the chart, with no tabs', async ({ page }) => {
        const seen = await routeAnalytics(page);
        await goto(page, '/analytics');
        await expect(page.getByRole('heading', { name: 'Shipped and spent, per day' })).toBeVisible();
        await expect(page.getByRole('button', { name: /^How .* is measured$/ })).toHaveCount(4);
        for (const label of TILES) await expect(page.getByRole('button', { name: `How ${label} is measured` })).toBeVisible();
        await expect(page.getByRole('tab')).toHaveCount(0);
        expect(seen).toEqual(['/api/analytics?window=month']);
    });

    test('deep links and the window picker write the window to the URL', async ({ page }) => {
        const seen = await routeAnalytics(page);
        await goto(page, '/analytics?window=7d');
        await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: '90 days' }).click();
        await expect(page).toHaveURL(/window=90d/);
        await expect.poll(() => seen).toContain('/api/analytics?window=90d');
        await page.getByRole('button', { name: 'This month' }).click();
        await expect(page).not.toHaveURL(/window=/);
    });

    test('every tile states its definition', async ({ page }) => {
        await routeAnalytics(page);
        await goto(page, '/analytics');
        await page.getByRole('button', { name: 'How Median cycle time is measured' }).hover();
        await expect(page.getByRole('tooltip')).toContainText('first move into In progress');
    });

    test('an empty window reads as empty, not broken', async ({ page }) => {
        await routeAnalytics(page, { empty: true });
        await goto(page, '/analytics');
        await expect(page.getByRole('heading', { name: CHART })).toBeVisible();
        await expect(page.getByText('—', { exact: true })).toBeVisible();
        await expect(page.getByText('$0.00', { exact: true })).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('against the real API, every window renders without errors', async ({ page }) => {
        for (const w of ['7d', '30d', '90d', 'month']) {
            await goto(page, w === 'month' ? '/analytics' : `/analytics?window=${w}`);
            await expect(page.getByRole('heading', { name: CHART })).toBeVisible();
            await expect(page.getByRole('alert')).toHaveCount(0);
        }
    });
});

for (const mode of ['light', 'dark'] as const) {
    test(`/analytics has no WCAG A/AA violations (${mode})`, async ({ page }) => {
        await page.addInitScript((m) => localStorage.setItem('atlas.themeMode', m), mode);
        await routeAnalytics(page);
        await goto(page, '/analytics');
        await expect(page.getByRole('heading', { name: CHART })).toBeVisible();
        await page.waitForTimeout(800);
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const summary = violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
        expect(summary, summary.join('\n')).toEqual([]);
    });
}

test.describe('/analytics on a phone @mobile', () => {
    test('fits the screen with tiles two to a row @mobile', async ({ page }) => {
        await routeAnalytics(page);
        await goto(page, '/analytics');
        await expect(page.getByRole('heading', { name: CHART })).toBeVisible();
        await page.waitForTimeout(500);
        const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            const offenders = [...document.body.querySelectorAll('*')]
                .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
                .slice(0, 3)
                .map((e) => e.tagName + '.' + String(e.className).slice(0, 40));
            return { scroll: doc.scrollWidth - doc.clientWidth, offenders };
        });
        expect(overflow).toEqual({ scroll: 0, offenders: [] });
        const tiles = page.getByRole('button', { name: /^How .* is measured$/ });
        const a = await tiles.nth(0).boundingBox();
        const b = await tiles.nth(1).boundingBox();
        expect(a && b && Math.abs(a.y - b.y) < 4).toBe(true);
    });
});
