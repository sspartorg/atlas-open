import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useLocation } from 'react-router-dom';
import type { IAnalytics } from '@atlas/shared';
import { server } from '../test-setup.js';
import { renderWithProviders } from '../test-utils/renderWithProviders.js';
import { Analytics } from './Analytics.js';

const BASE = 'http://localhost:3000/api';

function fixture(over: Partial<IAnalytics> = {}): IAnalytics {
    return {
        period: { window: 'month', tz: 'UTC', bucket: 'day', start: '2026-10-01T00:00:00.000Z', end: '2026-10-03T12:00:00.000Z' },
        tasks_shipped: 6,
        prs_merged: 5,
        cycle_p50_s: 7 * 3600,
        spend_usd: 24,
        series: [
            { bucket: '2026-10-01', tasks_shipped: 2, spend_usd: 10 },
            { bucket: '2026-10-02', tasks_shipped: 4, spend_usd: 14 },
            { bucket: '2026-10-03', tasks_shipped: 0, spend_usd: 0 },
        ],
        ...over,
    };
}

/** Route the endpoint and record every request's window. */
function mock(opts: { body?: IAnalytics; fail?: boolean } = {}) {
    const calls: string[] = [];
    server.use(
        http.get(`${BASE}/analytics`, ({ request }) => {
            calls.push(new URL(request.url).searchParams.get('window') ?? '');
            if (opts.fail) return HttpResponse.json({ error: 'boom' }, { status: 500 });
            return HttpResponse.json(opts.body ?? fixture());
        }),
    );
    return calls;
}

function Location() {
    return <div data-testid="loc">{useLocation().search}</div>;
}

function renderAt(path: string) {
    return renderWithProviders(
        <>
            <Analytics />
            <Location />
        </>,
        { initialEntries: [path] },
    );
}

describe('Analytics', () => {
    it('shows the four numbers and the chart for this month', async () => {
        const calls = mock();
        renderAt('/analytics');
        expect(await screen.findByText('Median cycle time')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('6')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
        expect(screen.getByText('7.0h')).toBeInTheDocument();
        expect(screen.getByText('$24.00')).toBeInTheDocument();
        for (const label of ['Tasks shipped', 'PRs merged', 'Median cycle time', 'Spend']) {
            expect(screen.getByRole('button', { name: `How ${label} is measured` })).toBeInTheDocument();
        }
        expect(screen.getByRole('heading', { name: 'Shipped and spent, per day' })).toBeInTheDocument();
        expect(screen.queryByRole('tab')).not.toBeInTheDocument();
        expect(calls).toEqual(['month']);
    });

    it('writes the window to the URL and drops the default', async () => {
        const calls = mock();
        renderAt('/analytics');
        await screen.findByText('Median cycle time');
        fireEvent.click(screen.getByRole('button', { name: '90 days' }));
        await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('?window=90d'));
        await waitFor(() => expect(calls).toContain('90d'));
        fireEvent.click(screen.getByRole('button', { name: 'This month' }));
        await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^$/));
    });

    it('deep-links a window and ignores an unknown one', async () => {
        const calls = mock();
        renderAt('/analytics?window=7d');
        await screen.findByText('Median cycle time');
        expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
        expect(calls).toEqual(['7d']);
    });

    it('falls back to this month for an unknown window', async () => {
        mock();
        renderAt('/analytics?window=1y');
        await screen.findByText('Median cycle time');
        expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('reads weekly buckets and an empty window honestly', async () => {
        mock({
            body: fixture({
                period: { ...fixture().period, window: '90d', bucket: 'week' },
                tasks_shipped: 0,
                prs_merged: 0,
                cycle_p50_s: null,
                spend_usd: 0,
                series: [{ bucket: '2026-09-28', tasks_shipped: 0, spend_usd: 0 }],
            }),
        });
        renderAt('/analytics?window=90d');
        expect(await screen.findByRole('heading', { name: 'Shipped and spent, per week' })).toBeInTheDocument();
        expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows a skeleton while loading, then the API error instead of a blank page', async () => {
        mock({ fail: true });
        renderAt('/analytics');
        expect(screen.getByLabelText('Loading')).toBeInTheDocument();
        expect(await screen.findByText(/Could not load analytics/)).toBeInTheDocument();
    });
});
