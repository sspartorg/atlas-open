import type { Knex } from 'knex';

// atlas-open: one Task, one agent. Every Task run is a `workflow_runs` row on
// the built-in `solo` workflow, whose graph is frozen per run from the Task's
// assignee (`soloGraph` in workflow-engine.ts). The row is only the FK anchor
// for those runs: the engine reads none of its settings, so it is seeded
// inactive and project-less (input_kind 'none' satisfies the project check).
//
// An install upgraded from a workflow edition keeps its history, but its other
// workflows can no longer run: they go inactive and their live runs stop.
// A Jira source now names the agent its imported Tasks are assigned to.

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        INSERT INTO public.workflows (id, name, description, status, input_kind, trigger, use_worktree)
        VALUES ('solo', 'Single agent', 'A Task''s assigned agent runs it end to end.', 'inactive', 'none', 'manual', false)
        ON CONFLICT (id) DO NOTHING
    `);
    await knex.raw(`UPDATE public.workflows SET status = 'inactive' WHERE id <> 'solo'`);
    await knex.raw(`
        UPDATE public.workflow_runs SET status = 'cancelled', finished_at = now()
        WHERE workflow_id <> 'solo' AND status IN ('running', 'waiting_for_owner')
    `);
    await knex.raw(`
        ALTER TABLE public.jira_sources
        ADD COLUMN IF NOT EXISTS agent_id text REFERENCES public.agents(id) ON DELETE SET NULL
    `);
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_jira_sources_agent_id ON public.jira_sources (agent_id)');
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw('ALTER TABLE public.jira_sources DROP COLUMN IF EXISTS agent_id');
    await knex.raw(`DELETE FROM public.workflows WHERE id = 'solo'`);
}
