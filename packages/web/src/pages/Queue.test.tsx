import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { IQueue, IQueueEntry } from '@atlas/shared';
import { server } from '../test-setup.js';
import { renderWithProviders } from '../test-utils/renderWithProviders.js';
import { Queue } from './Queue.js';

const BASE = 'http://localhost:3000/api';

function entry(overrides: Partial<IQueueEntry> = {}): IQueueEntry {
    return {
        kind: 'task',
        id: 'ATL-1',
        title: 'Fix the login',
        agent_id: 'agent-solo',
        agent_name: 'Solo Engineer',
        accent_color: '#31AB46',
        since: new Date(Date.now() - 5 * 60_000).toISOString(),
        run_id: 'wr-1',
        blocked_reason: null,
        ...overrides,
    };
}

function mockQueue(q: Partial<IQueue>) {
    server.use(
        http.get(`${BASE}/queue`, () =>
            HttpResponse.json({ slots: 1, running: [], waiting: [], scheduled: [], ...q })
        )
    );
}

describe('Queue page', () => {
    it('shows plain empty states', async () => {
        mockQueue({});
        renderWithProviders(<Queue />);
        expect(await screen.findByText('Nothing is running.')).toBeInTheDocument();
        expect(screen.getByText('Running now · 0 / 1')).toBeInTheDocument();
        expect(screen.getByText('Nothing is waiting.')).toBeInTheDocument();
        expect(screen.getByText(/No agent runs on a schedule/)).toBeInTheDocument();
    });

    it('shows an error when the queue fails to load', async () => {
        server.use(http.get(`${BASE}/queue`, () => HttpResponse.json({ error: 'x' }, { status: 500 })));
        renderWithProviders(<Queue />);
        expect(await screen.findByText('Could not load the queue.')).toBeInTheDocument();
    });

    it('lists the running Task with its elapsed time, and Stop stops its run', async () => {
        let stopped = '';
        mockQueue({ running: [entry()] });
        server.use(
            http.post(`${BASE}/workflow-runs/:id/stop`, ({ params }) => {
                stopped = String(params['id']);
                return HttpResponse.json({ id: params['id'], item_id: null });
            })
        );
        renderWithProviders(<Queue />);
        const link = await screen.findByRole('link', { name: 'Fix the login' });
        expect(link).toHaveAttribute('href', '/tasks/ATL-1');
        expect(screen.getByText('Running now · 1 / 1')).toBeInTheDocument();
        expect(screen.getByText('5m')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await waitFor(() => expect(stopped).toBe('wr-1'));
    });

    it('stops a running agent run through the run endpoint, linking to the run', async () => {
        let stopped = '';
        mockQueue({
            running: [entry({ kind: 'agent_run', id: 'ar-1', run_id: 'ar-1', title: 'Scout run', agent_id: 'agent-scout', since: '' })],
        });
        server.use(
            http.post(`${BASE}/run/:id/stop`, ({ params }) => {
                stopped = String(params['id']);
                return HttpResponse.json({ runId: params['id'], status: 'cancelled' });
            })
        );
        renderWithProviders(<Queue />);
        const link = await screen.findByRole('link', { name: 'Scout run' });
        expect(link).toHaveAttribute('href', '/agents/agent-scout/runs/ar-1');
        expect(screen.getByText('—')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
        await waitFor(() => expect(stopped).toBe('ar-1'));
    });

    it('disables Stop while a running Task has no run yet', async () => {
        mockQueue({ running: [entry({ run_id: null })] });
        renderWithProviders(<Queue />);
        expect(await screen.findByRole('button', { name: 'Stop' })).toBeDisabled();
    });

    it('numbers the waiting list, names why each is held, and cancels a waiting agent run', async () => {
        let cancelled = '';
        mockQueue({
            waiting: [
                entry({ id: 'ATL-2', title: 'Next up', run_id: null }),
                entry({ id: 'ATL-3', title: 'Same repo', run_id: null, blocked_reason: 'repo_busy' }),
                entry({ id: 'ATL-4', title: 'Blocked', run_id: null, blocked_reason: 'dependency' }),
                entry({ kind: 'agent_run', id: 'ar-9', run_id: null, title: 'Digest run', blocked_reason: 'awaiting_schedule' }),
            ],
        });
        server.use(
            http.post(`${BASE}/run/:id/stop`, ({ params }) => {
                cancelled = String(params['id']);
                return HttpResponse.json({ runId: params['id'], status: 'cancelled' });
            })
        );
        renderWithProviders(<Queue />);
        expect(await screen.findByText('Waiting · 4')).toBeInTheDocument();
        const rows = screen.getAllByRole('listitem');
        expect(within(rows[0] as HTMLElement).getByText('1')).toBeInTheDocument();
        expect(screen.getByText('Repo busy')).toBeInTheDocument();
        expect(screen.getByText('Waiting on a dependency')).toBeInTheDocument();
        expect(screen.getByText('Waits for schedule')).toBeInTheDocument();
        const cancels = screen.getAllByRole('button', { name: 'Cancel' });
        expect(cancels).toHaveLength(1);
        await userEvent.click(cancels[0] as HTMLElement);
        await waitFor(() => expect(cancelled).toBe('ar-9'));
    });

    it('lists scheduled agents with cron, next run, Due and No item chips', async () => {
        mockQueue({
            scheduled: [
                {
                    agent_id: 'agent-news',
                    agent_name: 'AI News',
                    accent_color: '#007AC9',
                    requires_item: false,
                    schedule_cron_expression: '0 9 * * *',
                    schedule_next_run_at: '2026-05-16T09:00:00.000Z',
                    schedule_due_at: '2026-05-15T09:00:00.000Z',
                },
                {
                    agent_id: 'agent-solo',
                    agent_name: 'Solo Engineer',
                    accent_color: '#31AB46',
                    requires_item: true,
                    schedule_cron_expression: '0 * * * *',
                    schedule_next_run_at: null,
                    schedule_due_at: null,
                },
            ],
        });
        renderWithProviders(<Queue />);
        expect(await screen.findByText('0 9 * * *')).toBeInTheDocument();
        expect(screen.getByText('0 * * * *')).toBeInTheDocument();
        expect(screen.getAllByText('Due')).toHaveLength(1);
        expect(screen.getAllByText('No item')).toHaveLength(1);
        expect(screen.getByText('Next: —')).toBeInTheDocument();
    });
});
