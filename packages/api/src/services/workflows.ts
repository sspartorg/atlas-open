// Task run read-models. Execution lives in `workflow-engine.ts`.

import {
    type AgentEffort,
    type IWorkflowGraph,
    type IWorkflowRunDetail,
    type IWorkflowRunSummary,
} from '@atlas/shared';
import { db } from '../db/kysely-client.js';

function asRunSummary(row: Record<string, unknown>): IWorkflowRunSummary {
    return {
        id: row['id'] as string,
        workflow_id: row['workflow_id'] as string,
        item_id: (row['item_id'] as string | null) ?? null,
        project_id: (row['project_id'] as string | null) ?? null,
        status: row['status'] as IWorkflowRunSummary['status'],
        graph_snapshot: row['graph_snapshot'] as IWorkflowGraph,
        current_node_id: (row['current_node_id'] as string | null) ?? null,
        parked_node_id: (row['parked_node_id'] as string | null) ?? null,
        park_reason: (row['park_reason'] as string | null) ?? null,
        branch: (row['branch'] as string | null) ?? null,
        worktree_path: (row['worktree_path'] as string | null) ?? null,
        setup_done: row['setup_done'] as boolean,
        pr_url: (row['pr_url'] as string | null) ?? null,
        pr_urls: (row['pr_urls'] as string[] | null) ?? [],
        started_at: row['started_at'] as string,
        updated_at: row['updated_at'] as string,
        finished_at: (row['finished_at'] as string | null) ?? null,
        item_title: (row['item_title'] as string | null) ?? null,
    };
}

/** Cost of every agent step across the given workflow runs. */
async function runCost(runIds: string[]): Promise<number> {
    const row = await db
        .selectFrom('agent_runs')
        .select((eb) => eb.fn.sum<string | number | null>('total_cost_usd').as('total'))
        .where('workflow_run_id', 'in', runIds)
        .executeTakeFirst();
    return Number(row?.total ?? 0);
}

export const workflowsService = {
    async listRunsForItem(itemId: string): Promise<IWorkflowRunSummary[]> {
        const rows = await db
            .selectFrom('workflow_runs as wr')
            .leftJoin('items as i', 'i.id', 'wr.item_id')
            .selectAll('wr')
            .select('i.title as item_title')
            .where('wr.item_id', '=', itemId)
            .orderBy('wr.started_at', 'desc')
            .limit(20)
            .execute();
        return rows.map((r) => asRunSummary(r as never));
    },

    async getRun(runId: string): Promise<IWorkflowRunDetail | null> {
        const row = await db
            .selectFrom('workflow_runs as wr')
            .leftJoin('items as i', 'i.id', 'wr.item_id')
            .selectAll('wr')
            .select('i.title as item_title')
            .where('wr.id', '=', runId)
            .executeTakeFirst();
        if (!row) return null;
        const steps = await db
            .selectFrom('agent_runs as ar')
            .leftJoin('agents as a', 'a.id', 'ar.agent_id')
            .select([
                'ar.id',
                'ar.node_id',
                'ar.agent_id',
                'a.name as agent_name',
                'ar.status',
                'ar.cli',
                'ar.model',
                'ar.effort',
                'ar.outcome_kind',
                'ar.outcome_summary',
                'ar.outcome_reason',
                'ar.total_cost_usd',
                'ar.started_at',
                'ar.completed_at',
            ])
            .where('ar.workflow_run_id', '=', runId)
            .orderBy('ar.created_at', 'asc')
            .execute();
        return {
            ...asRunSummary(row as never),
            total_cost_usd: await runCost([runId]),
            steps: steps.map((s) => ({
                id: s.id,
                node_id: s.node_id ?? null,
                agent_id: s.agent_id,
                agent_name: s.agent_name ?? null,
                status: s.status,
                cli: s.cli ?? null,
                model: s.model ?? null,
                // agent_runs.effort is plain text; the runner only writes AgentEffort values.
                effort: (s.effort as AgentEffort | null) ?? null,
                outcome_kind: s.outcome_kind ?? null,
                outcome_summary: s.outcome_summary ?? null,
                outcome_reason: s.outcome_reason ?? null,
                total_cost_usd: s.total_cost_usd === null ? null : Number(s.total_cost_usd),
                started_at: s.started_at ?? null,
                completed_at: s.completed_at ?? null,
            })),
        };
    },
};
