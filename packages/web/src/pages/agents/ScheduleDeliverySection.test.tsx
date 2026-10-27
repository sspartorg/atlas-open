import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { IAgent } from '@atlas/shared';
import { server } from '../../test-setup.js';
import { renderWithProviders } from '../../test-utils/renderWithProviders.js';
import { makeAgent } from '../../test-utils/factories.js';
import { Toast } from '../../components/Toast.js';
import { ScheduleDeliverySection, chainDelivery } from './ScheduleDeliverySection.js';

const BASE = 'http://localhost:3000/api';
const ALL_OFF = { git_commit: false, git_push: false, git_open_pr: false };
const ALL_ON = { git_commit: true, git_push: true, git_open_pr: true };

describe('chainDelivery', () => {
    it('turning PR on turns push and commit on', () => {
        expect(chainDelivery(ALL_OFF, 'git_open_pr', true)).toEqual(ALL_ON);
    });
    it('turning push on turns commit on, leaves PR', () => {
        expect(chainDelivery(ALL_OFF, 'git_push', true)).toEqual({ git_commit: true, git_push: true, git_open_pr: false });
    });
    it('turning commit on touches nothing else', () => {
        expect(chainDelivery(ALL_OFF, 'git_commit', true)).toEqual({ ...ALL_OFF, git_commit: true });
    });
    it('turning commit off turns push and PR off', () => {
        expect(chainDelivery(ALL_ON, 'git_commit', false)).toEqual(ALL_OFF);
    });
    it('turning push off turns PR off, keeps commit', () => {
        expect(chainDelivery(ALL_ON, 'git_push', false)).toEqual({ git_commit: true, git_push: false, git_open_pr: false });
    });
    it('turning PR off keeps the rest', () => {
        expect(chainDelivery(ALL_ON, 'git_open_pr', false)).toEqual({ ...ALL_ON, git_open_pr: false });
    });
});

function capturePatch(reply: (body: Partial<IAgent>) => IAgent) {
    const bodies: Array<Partial<IAgent>> = [];
    server.use(
        http.patch(`${BASE}/agents/:id`, async ({ request }) => {
            const body = (await request.json()) as Partial<IAgent>;
            bodies.push(body);
            return HttpResponse.json(reply(body));
        })
    );
    return bodies;
}

describe('ScheduleDeliverySection', () => {
    it('chains the git switches and saves all three flags with the schedule fields', async () => {
        const agent = makeAgent();
        const bodies = capturePatch((b) => ({ ...agent, ...b }));
        renderWithProviders(<><ScheduleDeliverySection agent={agent} /><Toast /></>);
        const save = screen.getByRole('button', { name: 'Save schedule & delivery' });
        expect(save).toBeDisabled();

        await userEvent.click(screen.getByRole('switch', { name: 'Commit' }));
        expect(screen.getByRole('switch', { name: 'Push' })).not.toBeChecked();
        expect(screen.getByRole('switch', { name: 'Open pull request' })).not.toBeChecked();
        expect(screen.getByText(/Changes stay uncommitted/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole('switch', { name: 'Open pull request' }));
        expect(screen.getByRole('switch', { name: 'Commit' })).toBeChecked();
        await userEvent.click(screen.getByRole('switch', { name: 'Push' }));
        expect(screen.getByRole('switch', { name: 'Open pull request' })).not.toBeChecked();

        await userEvent.click(save);
        await waitFor(() => expect(bodies).toHaveLength(1));
        expect(bodies[0]).toEqual({
            requires_item: true,
            git_commit: true,
            git_push: false,
            git_open_pr: false,
            schedule_enabled: false,
            schedule_preset: 'daily',
            schedule_time_of_day: '09:00',
            schedule_weekday: null,
            schedule_cron_expression: '0 9 * * *',
        });
        expect(await screen.findByText('Schedule & delivery saved')).toBeInTheDocument();
    });

    it('hides delivery for an agent that runs on its own', async () => {
        renderWithProviders(<ScheduleDeliverySection agent={makeAgent()} />);
        await userEvent.click(screen.getByRole('switch', { name: 'Works on a Task' }));
        expect(screen.getByText('Runs in a scratch folder; never touches git.')).toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: 'Commit' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(screen.getByRole('switch', { name: 'Works on a Task' })).toBeChecked();
    });

    it('edits the schedule and adopts the server copy after save', async () => {
        const agent = makeAgent({ schedule_next_run_at: '2026-05-17T09:00:00.000Z' });
        const bodies = capturePatch((b) => ({ ...agent, ...b, schedule_cron_expression: '30 7 * * 2' }));
        renderWithProviders(<><ScheduleDeliverySection agent={agent} /><Toast /></>);
        await userEvent.click(screen.getByRole('switch', { name: 'Run on a schedule' }));
        expect(screen.getByText(/Next run:/)).toBeInTheDocument();
        expect(screen.queryByText('—')).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: /Weekly/ }));
        fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '07:30' } });
        await userEvent.click(screen.getByRole('button', { name: /Custom cron/ }));
        fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '30 7 * * 2' } });

        await userEvent.click(screen.getByRole('button', { name: 'Save schedule & delivery' }));
        await waitFor(() => expect(bodies).toHaveLength(1));
        expect(bodies[0]).toMatchObject({
            schedule_enabled: true,
            schedule_preset: 'custom',
            schedule_weekday: 1,
            schedule_time_of_day: '07:30',
            schedule_cron_expression: '30 7 * * 2',
        });
        expect(await screen.findByText('Schedule & delivery saved')).toBeInTheDocument();
    });

    it('shows a dash when the schedule has no next run yet', async () => {
        renderWithProviders(<ScheduleDeliverySection agent={makeAgent({ schedule_enabled: true })} />);
        expect(screen.getByText('—')).toBeInTheDocument();
        expect(screen.getByLabelText('Time of day')).toBeInTheDocument();
    });
});
