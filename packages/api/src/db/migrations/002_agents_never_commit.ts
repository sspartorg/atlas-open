import type { Knex } from 'knex';

// ADR 0015 — agents only edit files; Atlas commits, pushes and opens the PR.
//
// The architect / engineer / qa / automation role prompts carried by the
// baseline told agents to `git push` and `gh pr create`. Nothing assembles
// them into a prompt any more, but they are the next thing someone would wire
// back in, so they go. The column is NOT NULL DEFAULT '', hence ''.
//
// The seeded `commit-discipline` guardrail script checked a Co-Authored-By
// trailer on every agent commit. With no agent commits it has nothing to
// check, and the seed no longer carries it. Project copies the Owner made
// (`project_guardrail_scripts`) are theirs and stay.

export async function up(knex: Knex): Promise<void> {
    await knex('roles')
        .whereIn('id', ['architect', 'engineer', 'qa', 'automation'])
        .update({ default_prompt_md: '', updated_at: knex.fn.now() });
    await knex('guardrail_scripts').where('id', 'commit-discipline').delete();
}

export async function down(_knex: Knex): Promise<void> {
    // No-op: the cleared prompts were dead text, and `seed.ts` no longer
    // carries the guardrail script to restore.
}
