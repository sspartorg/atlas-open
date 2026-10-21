import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test-setup.js';
import { renderWithProviders } from '../../test-utils/renderWithProviders.js';
import { deliveryFixture, emptyDeliveryFixture, spendFixture } from '../../test-utils/analyticsFixtures.js';
import { FORMAT, Sparkline, StatTile, trendFor } from './_chrome.js';
import { DeliveryTab } from './DeliveryTab.js';
import { SpendTab } from './SpendTab.js';

// The trend on every tile, and the flow, quality and cost-efficiency
// metrics: each states its definition and reads honestly when empty.

const BASE = 'http://localhost:3000/api';

function serve(path: string, body: Parameters<typeof HttpResponse.json>[0]) {
    server.use(http.get(`${BASE}${path}`, () => HttpResponse.json(body)));
}

const definition = (label: string) => screen.getByRole('button', { name: `How ${label} is measured` });

describe('Sparkline', () => {
    it('draws one line, breaks it where a bucket is empty, and says the range in words', () => {
        const { container } = renderWithProviders(<Sparkline series={[1, 3, null, 2]} label="Spend per day: lowest 1, highest 3" />);
        const svg = screen.getByRole('img', { name: 'Spend per day: lowest 1, highest 3' });
        // Two runs of points: 1→3, then 2 alone after the gap.
        expect(svg.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
        expect(container.querySelectorAll('circle')).toHaveLength(1);
    });

    it('draws nothing with fewer than two points', () => {
        renderWithProviders(<Sparkline series={[null, 4, null]} label="x" />);
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
});

describe('StatTile trend', () => {
    it('shows the change against the previous window and a labelled sparkline', () => {
        renderWithProviders(
            <StatTile
                label="Spend"
                value="$24.00"
                definition="d"
                trend={trendFor({ cur: 24, prev: 32, series: [9, 0, 15] }, 'down', '7d', 'day', FORMAT.usd)}
            />,
        );
        // Down 25%, and down is good for spend: green, not red.
        expect(screen.getByText(/down 25%/)).toBeInTheDocument();
        expect(screen.getByText(/vs the 7 days before/)).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Spend per day: lowest $0.00, highest $15.00, latest $15.00' })).toBeInTheDocument();
    });

    it('says — when there is no earlier window to compare', () => {
        renderWithProviders(
            <StatTile label="Rate" value="50%" definition="d" trend={trendFor({ cur: 0.5, prev: null, series: [null, null] }, 'up', 'month', 'day', FORMAT.rate, true)} />,
        );
        expect(screen.getByTitle('No earlier data to compare')).toHaveTextContent('—');
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
});

describe('Delivery — flow and quality', () => {
    it('shows each new metric with its definition and a trend', async () => {
        serve('/analytics/delivery', deliveryFixture());
        renderWithProviders(<DeliveryTab window="month" />);
        const group = await screen.findByRole('region', { name: 'Flow and quality' });
        for (const label of ['Flow efficiency', 'Your response to parks', 'Weekly throughput', 'Rework after Done', 'First-attempt merges']) {
            expect(definition(label)).toBeInTheDocument();
        }
        expect(within(group).getByText('40%')).toBeInTheDocument();
        expect(within(group).getByText('2.5d worked · 3.8d waiting')).toBeInTheDocument();
        expect(within(group).getByText('p90 6.0h · 3 answered · 1 open')).toBeInTheDocument();
        expect(within(group).getByText('14.0')).toBeInTheDocument();
        expect(within(group).getByText('1 of 6 shipped')).toBeInTheDocument();
        expect(within(group).getByText('2 of 4 merged runs')).toBeInTheDocument();
        // Flow efficiency 40% vs 50% before: down 10 points, which is bad news.
        expect(within(group).getAllByText(/down 10/)[0]).toHaveTextContent('pts');
        // Every Delivery tile carries a trend line (13 tiles).
        expect(screen.getAllByText(/vs the same days last month/)).toHaveLength(13);
    });

    it('reads honestly when nothing shipped or parked', async () => {
        serve('/analytics/delivery', emptyDeliveryFixture());
        renderWithProviders(<DeliveryTab window="7d" />);
        const group = await screen.findByRole('region', { name: 'Flow and quality' });
        expect(within(group).getByText('nothing shipped')).toBeInTheDocument();
        expect(within(group).getByText('no parks')).toBeInTheDocument();
        expect(within(group).getByText('no merged runs')).toBeInTheDocument();
        expect(within(group).getByText('0 of 0 shipped')).toBeInTheDocument();
    });
});

describe('Spend — cost efficiency', () => {
    it('breaks run cost down per PR and per shipped Task by model', async () => {
        serve('/analytics', spendFixture());
        renderWithProviders(<SpendTab window="month" />);
        const byModel = await screen.findByRole('table', { name: 'Cost per PR and Task by model' });
        expect(within(byModel).getByText('claude-opus-5-5 · claude')).toBeInTheDocument();
        expect(screen.getByText('Cache savings per day')).toBeInTheDocument();
        expect(screen.getAllByText(/vs the same days last month/)).toHaveLength(4);
    });

    it('reads empty without runs or cache savings', async () => {
        const s = spendFixture();
        serve('/analytics', {
            ...s,
            trends: { ...s.trends, cache_savings: { cur: 0, prev: 0, series: [0, 0, 0] } },
            cost_efficiency: { by_workflow: [], by_model: [] },
        });
        renderWithProviders(<SpendTab window="month" />);
        expect(await screen.findByText('No Task runs in this window')).toBeInTheDocument();
        expect(screen.getByText('No cache savings in this window')).toBeInTheDocument();
    });
});
