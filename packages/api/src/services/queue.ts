import { MAX_CONCURRENT_AGENTS, type IQueue, type IQueueEntry } from '@atlas/shared';
import { db } from '../db/kysely-client.js';
import { listDispatchQueue } from './workflow-engine.js';

const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

/** ADR 0033 — the Queue page: what holds the slot, what waits for it, and which agents are scheduled. */
export async function getQueue(): Promise<IQueue> {
    const [taskRuns, agentRuns, waiting, scheduled] = await Promise.all([
        db
            .selectFrom('workflow_runs as wr')
            .innerJoin('items as i', 'i.id', 'wr.item_id')
            .innerJoin('agents as a', 'a.id', 'i.assignee_agent_id')
            .select(['wr.id as run_id', 'i.id', 'i.title', 'a.id as agent_id', 'a.name as agent_name', 'a.accent_color', 'wr.started_at as since'])
            .where('wr.status', '=', 'running')
            .execute(),
        db
            .selectFrom('agent_runs as r')
            .innerJoin('agents as a', 'a.id', 'r.agent_id')
            .select(['r.id', 'a.id as agent_id', 'a.name as agent_name', 'a.accent_color', 'r.started_at as since'])
            .where('r.status', 'in', ['queued', 'in_progress'])
            .where('r.started_at', 'is not', null)
            .where('r.workflow_run_id', 'is', null)
            .where('r.item_id', 'is', null)
            .where(({ not, exists, selectFrom }) => not(exists(selectFrom('agent_test_runs as t').select('t.id').whereRef('t.agent_run_id', '=', 'r.id'))))
            .execute(),
        listDispatchQueue(),
        db
            .selectFrom('agents')
            .select(['id', 'name', 'accent_color', 'requires_item', 'schedule_cron_expression', 'schedule_next_run_at', 'schedule_due_at'])
            .where('schedule_enabled', '=', true)
            .where('status', '=', 'active')
            .orderBy('schedule_next_run_at', 'asc')
            .execute(),
    ]);
    const running: IQueueEntry[] = [
        ...taskRuns.map((r) => ({
            kind: 'task' as const,
            id: r.id,
            title: r.title,
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            accent_color: r.accent_color,
            since: iso(r.since) ?? '',
            run_id: r.run_id,
            blocked_reason: null,
        })),
        ...agentRuns.map((r) => ({
            kind: 'agent_run' as const,
            id: r.id,
            title: `${r.agent_name} run`,
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            accent_color: r.accent_color,
            since: iso(r.since) ?? '',
            run_id: r.id,
            blocked_reason: null,
        })),
    ];
    return {
        slots: MAX_CONCURRENT_AGENTS,
        running,
        waiting: waiting.map(({ scheduled: _s, ...e }) => e),
        scheduled: scheduled.map((a) => ({
            agent_id: a.id,
            agent_name: a.name,
            accent_color: a.accent_color,
            requires_item: a.requires_item,
            schedule_cron_expression: a.schedule_cron_expression,
            schedule_next_run_at: iso(a.schedule_next_run_at),
            schedule_due_at: iso(a.schedule_due_at),
        })),
    };
}
