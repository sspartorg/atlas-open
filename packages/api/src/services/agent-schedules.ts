import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { deliveryChainError, type IAgent } from '@atlas/shared';
import { db } from '../db/kysely-client.js';
import { broadcastSSE } from '../routes/events.js';
import { ApiError } from '../utils/errors.js';
import { materializeCron } from './cron-materializer.js';

// ADR 0033 — an agent's schedule gates when it starts work. A fire that
// passes marks the agent due; dispatch consumes the mark when the single
// slot is free. Fires missed while the slot was busy (or the API was down)
// collapse into one.

type RunConfig = Pick<
    IAgent,
    | 'requires_item'
    | 'git_commit'
    | 'git_push'
    | 'git_open_pr'
    | 'schedule_enabled'
    | 'schedule_preset'
    | 'schedule_time_of_day'
    | 'schedule_weekday'
    | 'schedule_cron_expression'
>;

/** The run config a catalog manifest or bundle declares, over migration 004's defaults. */
export function runConfigOf(m: Partial<RunConfig>): RunConfig {
    return {
        requires_item: m.requires_item ?? true,
        git_commit: m.git_commit ?? true,
        git_push: m.git_push ?? true,
        git_open_pr: m.git_open_pr ?? true,
        schedule_enabled: m.schedule_enabled ?? false,
        schedule_preset: m.schedule_preset ?? 'daily',
        schedule_time_of_day: m.schedule_time_of_day ?? '09:00',
        schedule_weekday: m.schedule_weekday ?? null,
        schedule_cron_expression: m.schedule_cron_expression ?? '0 9 * * *',
    };
}

/** An agent row's run config at install: the catalog's, with its next fire when the schedule ships on. */
export function installRunConfig(m: Partial<RunConfig>, now = new Date()): RunConfig & { schedule_next_run_at: string | null } {
    const c = runConfigOf(m);
    return { ...c, schedule_next_run_at: c.schedule_enabled ? nextFireAt(c.schedule_cron_expression, now) : null };
}

export function nextFireAt(cronExpression: string, from: Date): string | null {
    return new Cron(cronExpression, { paused: true }).nextRun(from)?.toISOString() ?? null;
}

/**
 * The columns an agent save writes for its run config: the PATCH merged over
 * the stored row, validated as a whole (a PATCH may send one flag only), the
 * cron materialised from the preset, and the next fire recomputed.
 */
export function runConfigColumns(existing: RunConfig | undefined, patch: Partial<RunConfig>, now = new Date()): Partial<IAgent> {
    const touched = (Object.keys(patch) as Array<keyof RunConfig>).filter((k) => patch[k] !== undefined);
    if (touched.length === 0) return {};
    const merged = { ...existing, ...Object.fromEntries(touched.map((k) => [k, patch[k]])) } as RunConfig;
    const chain = deliveryChainError(merged);
    if (chain) throw new ApiError('validation_error', chain, 400);
    const out: Partial<IAgent> = Object.fromEntries(touched.map((k) => [k, patch[k]]));
    if (!touched.some((k) => k.startsWith('schedule_'))) return out;
    let cron: string;
    try {
        cron = materializeCron({
            preset: merged.schedule_preset ?? 'daily',
            time_of_day: merged.schedule_time_of_day ?? '09:00',
            weekday: merged.schedule_weekday ?? null,
            cron_expression: merged.schedule_cron_expression ?? '',
        }).cron_expression;
    } catch (err) {
        throw new ApiError('validation_error', (err as Error).message, 400);
    }
    out.schedule_cron_expression = cron;
    out.schedule_next_run_at = merged.schedule_enabled ? nextFireAt(cron, now) : null;
    // Turning the schedule off drops a fire that has not started yet.
    if (!merged.schedule_enabled) out.schedule_due_at = null;
    return out;
}

/**
 * Minute tick: every active, scheduled agent whose fire has passed advances
 * to its next fire. An agent that works Tasks is marked due (dispatch hands
 * it its oldest ready Task); one that needs no item gets a queued run, unless
 * one is already waiting. Returns how many agents fired.
 */
export async function markDueAgents(now = new Date()): Promise<number> {
    const due = await db
        .selectFrom('agents')
        .select(['id', 'requires_item', 'schedule_cron_expression', 'schedule_next_run_at', 'schedule_due_at'])
        .where('status', '=', 'active')
        .where('schedule_enabled', '=', true)
        .where('schedule_next_run_at', '<=', now.toISOString())
        .execute();
    for (const a of due) {
        await db
            .updateTable('agents')
            .set({
                schedule_next_run_at: nextFireAt(a.schedule_cron_expression, now),
                ...(a.requires_item ? { schedule_due_at: a.schedule_due_at ?? a.schedule_next_run_at } : {}),
            })
            .where('id', '=', a.id)
            .execute();
        if (!a.requires_item) await queueAgentRun(a.id);
    }
    if (due.length > 0) broadcastSSE({ type: 'counts_changed' });
    return due.length;
}

/**
 * A run of one agent on nothing, waiting for the slot: `queued` and not
 * started yet. Dispatch starts it (`startQueuedAgentRun`). Returns the waiting
 * run's id — an existing one when `collapse` finds one already waiting.
 */
export async function queueAgentRun(agentId: string, opts: { projectId?: string | null; collapse?: boolean } = {}): Promise<string> {
    if (opts.collapse ?? true) {
        const waiting = await db
            .selectFrom('agent_runs')
            .select('id')
            .where('agent_id', '=', agentId)
            .where('status', '=', 'queued')
            .where('started_at', 'is', null)
            .where('item_id', 'is', null)
            .executeTakeFirst();
        if (waiting) return waiting.id;
    }
    const runId = randomUUID();
    await db
        .insertInto('agent_runs')
        .values({
            id: runId,
            agent_id: agentId,
            item_id: null,
            project_id: opts.projectId ?? null,
            status: 'queued',
            prompt_snapshot: null,
            // Null until dispatch hands it the slot (`startQueuedAgentRun`).
            started_at: null,
        })
        .execute();
    broadcastSSE({ type: 'run_queued', agentId, runId });
    return runId;
}
