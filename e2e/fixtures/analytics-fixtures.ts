import type { Page } from '@playwright/test';

// A realistic `GET /api/analytics` payload (`IAnalytics`, @atlas/shared) for the /analytics page. The e2e DB
// holds a handful of rows, which cannot show what the chart looks like with a
// month of work in it, so specs and screenshot passes route the endpoint here.

function days(n: number, end = new Date('2026-10-16T12:00:00Z')): string[] {
    return Array.from({ length: n }, (_, i) => new Date(end.getTime() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

function analyticsFixture(empty = false) {
    const series = days(16).map((bucket, i) =>
        empty ? { bucket, tasks_shipped: 0, spend_usd: 0 } : { bucket, tasks_shipped: (i * 3) % 5, spend_usd: Number((4 + ((i * 7) % 9) * 1.35).toFixed(2)) },
    );
    return {
        period: { window: 'month', tz: 'UTC', bucket: 'day', start: '2026-10-01T00:00:00.000Z', end: '2026-10-16T12:00:00.000Z' },
        tasks_shipped: series.reduce((n, b) => n + b.tasks_shipped, 0),
        prs_merged: empty ? 0 : 27,
        cycle_p50_s: empty ? null : 7.4 * 3600,
        spend_usd: series.reduce((n, b) => n + b.spend_usd, 0),
        series,
    };
}

/** Route the endpoint to the fixture; returns every request seen as `path?window=…`. */
export async function routeAnalytics(page: Page, opts: { empty?: boolean } = {}): Promise<string[]> {
    const seen: string[] = [];
    await page.route(/\/api\/analytics\?/, async (route) => {
        const url = new URL(route.request().url());
        seen.push(`${url.pathname}?window=${url.searchParams.get('window')}`);
        await route.fulfill({ json: analyticsFixture(opts.empty) });
    });
    return seen;
}
