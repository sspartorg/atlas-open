import { describe, expect, it } from 'vitest';
import { combineCi } from './ci-routing.js';

describe('combineCi', () => {
    const done = (name: string, conclusion: string, title?: string) => ({
        name,
        status: 'completed',
        conclusion,
        output: title ? { title } : null,
    });

    it('is null when the commit has no checks and no statuses — no CI is not green', () => {
        expect(combineCi([], [])).toEqual({ state: null, failing: [] });
    });

    it('all success / neutral / skipped is success', () => {
        expect(combineCi([done('a', 'success'), done('b', 'neutral'), done('c', 'skipped')], [{ state: 'success' }]).state).toBe(
            'success',
        );
    });

    it.each(['failure', 'cancelled', 'timed_out', 'action_required'])('%s is a failure, named with its title', (c) => {
        expect(combineCi([done('lint', c, 'Lint found 3 errors'), done('ok', 'success')], [])).toEqual({
            state: 'failure',
            failing: [{ name: 'lint', detail: 'Lint found 3 errors' }],
        });
    });

    it('falls back to the output summary, then to no detail', () => {
        expect(
            combineCi(
                [
                    { name: 'a', status: 'completed', conclusion: 'failure', output: { title: ' ', summary: 'sum' } },
                    { status: 'completed', conclusion: 'failure' },
                ],
                [],
            ).failing,
        ).toEqual([
            { name: 'a', detail: 'sum' },
            { name: 'check', detail: null },
        ]);
    });

    it('anything not completed is pending', () => {
        expect(combineCi([{ name: 'a', status: 'queued' }, done('b', 'success')], []).state).toBe('pending');
        expect(combineCi([{ name: 'a', status: 'in_progress' }], []).state).toBe('pending');
    });

    it('a failure wins over pending', () => {
        expect(combineCi([{ name: 'a', status: 'in_progress' }, done('b', 'failure')], []).state).toBe('failure');
    });

    it('reads legacy statuses: failure/error fail, pending waits', () => {
        expect(combineCi([], [{ context: 'ci/jenkins', state: 'error', description: 'boom' }, { state: 'failure' }])).toEqual({
            state: 'failure',
            failing: [
                { name: 'ci/jenkins', detail: 'boom' },
                { name: 'status', detail: null },
            ],
        });
        expect(combineCi([], [{ context: 'x', state: 'pending' }]).state).toBe('pending');
    });

    it('truncates long details', () => {
        const got = combineCi([done('a', 'failure', 'x'.repeat(500))], []);
        expect(got.failing[0]?.detail).toHaveLength(200);
    });
});
