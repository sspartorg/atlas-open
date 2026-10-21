import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import type { IWorkflowRunDetail } from '@atlas/shared';
import { server } from '../../test-setup.js';
import { renderWithProviders } from '../../test-utils/renderWithProviders.js';
import { makeRunDetail, makeRunStep } from '../../test-utils/runFixtures.js';
import { RunDetail } from './RunDetail.js';

const BASE = 'http://localhost:3000/api';

function mount(run: IWorkflowRunDetail) {
    server.use(
        http.get(`${BASE}/workflow-runs/${run.id}`, () => HttpResponse.json(run)),
        http.get(`${BASE}/workflow-runs/${run.id}/diff`, () =>
            HttpResponse.json({ run_id: run.id, branch: run.branch, repos: [] })
        )
    );
    return renderWithProviders(
        <Routes>
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/agents/:id/runs/:runId" element={<div>agent run page</div>} />
        </Routes>,
        { initialEntries: [`/runs/${run.id}`] }
    );
}

describe('RunDetail', () => {
    it('shows a running run with its agent step and offers Stop', async () => {
        mount(makeRunDetail());
        expect(await screen.findByText('Add login')).toBeInTheDocument();
        expect(screen.getByText('Coder')).toBeInTheDocument();
        expect(screen.getByText('Steps · 1')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'ATL-7' })).toHaveAttribute('href', '/tasks/ATL-7');
        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    });

    it('explains a parked run, offers Resume and resumes it', async () => {
        const user = userEvent.setup();
        const run = makeRunDetail({
            status: 'waiting_for_owner',
            park_reason: 'Which login provider?',
            steps: [
                makeRunStep({
                    status: 'error',
                    outcome_kind: null,
                    outcome_summary: null,
                    outcome_reason: 'CLI crashed',
                }),
            ],
        });
        let resumed = false;
        mount(run);
        server.use(
            http.post(`${BASE}/workflow-runs/${run.id}/resume`, () => {
                resumed = true;
                return HttpResponse.json({ ...run, status: 'running', park_reason: null });
            })
        );

        expect(await screen.findByText('Which login provider?')).toBeInTheDocument();
        expect(screen.getByText(/Reply on the Task to continue/)).toBeInTheDocument();
        expect(screen.getByText('CLI crashed')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Resume' }));
        await waitFor(() => expect(resumed).toBe(true));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
        );
    });

    it('links every pull request a delivered run opened', async () => {
        mount(
            makeRunDetail({
                status: 'completed',
                pr_url: 'https://github.com/o/a/pull/1',
                pr_urls: ['https://github.com/o/a/pull/1', 'https://github.com/o/b/pull/2'],
            })
        );
        expect(await screen.findByRole('link', { name: 'Pull request 2' })).toHaveAttribute(
            'href',
            'https://github.com/o/b/pull/2'
        );
        expect(screen.getByRole('link', { name: 'open the pull request' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    });

    it('opens the agent run page when a step is clicked', async () => {
        const user = userEvent.setup();
        mount(makeRunDetail());
        await user.click(await screen.findByTestId('wf-step-run-a'));
        expect(await screen.findByText('agent run page')).toBeInTheDocument();
    });

    it('says so when the run does not exist', async () => {
        server.use(
            http.get(`${BASE}/workflow-runs/nope`, () =>
                HttpResponse.json({ error: 'Run not found' }, { status: 404 })
            )
        );
        renderWithProviders(
            <Routes>
                <Route path="/runs/:runId" element={<RunDetail />} />
            </Routes>,
            { initialEntries: ['/runs/nope'] }
        );
        expect(await screen.findByText('Run not found.')).toBeInTheDocument();
    });
});
