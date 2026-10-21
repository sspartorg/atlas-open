import type { ExternalCiState, IExternalCiCheck } from '@atlas/shared';

// What the CI on a PR says, combined into one state for the item's PR chip.
// Pure: no DB, no fetch. `external-links.ts` reads GitHub.

/** The slice of a GitHub check run this reads. */
export interface GithubCheckRun {
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    output?: { title?: unknown; summary?: unknown } | null;
}

/** The slice of a legacy commit status this reads. */
export interface GithubCommitStatus {
    context?: unknown;
    state?: unknown;
    description?: unknown;
}

export interface CiResult {
    state: ExternalCiState | null;
    failing: IExternalCiCheck[];
}

const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const DETAIL_MAX = 200;

function text(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, DETAIL_MAX) : null;
}

/**
 * Check runs and legacy statuses are two APIs for one question, and a repo can
 * use either or both — so both are read and folded together. Any failure wins
 * over anything pending (a red check will not turn green by waiting), pending
 * wins over success, and nothing at all is `null`: a repo without CI must not
 * look like a passing one.
 *
 * The combined-status endpoint's own top-level `state` is deliberately
 * ignored: GitHub reports `pending` for a commit with zero statuses, which
 * would paint every Actions-only repo as forever pending.
 */
export function combineCi(checkRuns: GithubCheckRun[], statuses: GithubCommitStatus[]): CiResult {
    const failing: IExternalCiCheck[] = [];
    let pending = false;
    let seen = 0;
    for (const run of checkRuns) {
        seen++;
        if (run.status !== 'completed') {
            pending = true;
            continue;
        }
        if (typeof run.conclusion === 'string' && FAILED_CONCLUSIONS.has(run.conclusion)) {
            failing.push({
                name: text(run.name) ?? 'check',
                detail: text(run.output?.title) ?? text(run.output?.summary),
            });
        }
    }
    for (const s of statuses) {
        seen++;
        if (s.state === 'failure' || s.state === 'error') {
            failing.push({ name: text(s.context) ?? 'status', detail: text(s.description) });
        } else if (s.state === 'pending') {
            pending = true;
        }
    }
    if (failing.length > 0) return { state: 'failure', failing };
    if (pending) return { state: 'pending', failing };
    return { state: seen > 0 ? 'success' : null, failing };
}
