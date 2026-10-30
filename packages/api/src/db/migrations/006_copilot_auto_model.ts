import type { Knex } from 'knex';

// Some Copilot plans refuse every named model ("Model X from --model flag is
// not available") and run only with `--model auto`, which lets Copilot pick.
// Without this row an agent can't select it (agents (cli, model) → cli_models).

export async function up(knex: Knex): Promise<void> {
    await knex('cli_models')
        .insert({ id: 'seed-copilot-auto', cli: 'copilot', model_name: 'auto', note: 'Copilot picks the model. Works on every plan; ignores reasoning effort.', sort_order: 0 })
        .onConflict('id')
        .ignore();
}

export async function down(knex: Knex): Promise<void> {
    await knex('cli_models').where({ id: 'seed-copilot-auto' }).delete();
}
