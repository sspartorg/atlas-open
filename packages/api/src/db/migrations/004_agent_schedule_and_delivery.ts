import type { Knex } from 'knex';

// ADR 0033 — the free edition runs one agent at a time and every run is
// driven by its agent's own config: whether it works a Task, when it starts,
// and what Atlas does with its changes. The defaults keep the behaviour
// before this migration: works a Task, no schedule, commit + push + PR.
//
// `marketplace_agents` carries the same config (no next/due timestamps) so
// an install copies the catalog's defaults onto the agent.

const CHAIN = '(NOT git_push OR git_commit) AND (NOT git_open_pr OR git_push)';
const PRESETS = "schedule_preset IN ('hourly', 'every_4h', 'daily', 'weekly', 'custom')";

function addRunConfig(t: Knex.AlterTableBuilder): void {
    t.boolean('requires_item').notNullable().defaultTo(true);
    t.boolean('git_commit').notNullable().defaultTo(true);
    t.boolean('git_push').notNullable().defaultTo(true);
    t.boolean('git_open_pr').notNullable().defaultTo(true);
    t.boolean('schedule_enabled').notNullable().defaultTo(false);
    t.text('schedule_preset').notNullable().defaultTo('daily');
    t.text('schedule_time_of_day').notNullable().defaultTo('09:00');
    t.integer('schedule_weekday').nullable();
    t.text('schedule_cron_expression').notNullable().defaultTo('0 9 * * *');
}

export async function up(knex: Knex): Promise<void> {
    for (const table of ['agents', 'marketplace_agents']) {
        await knex.schema.alterTable(table, addRunConfig);
        await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${CHAIN})`, [table, `${table}_git_chain_check`]);
        await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${PRESETS})`, [table, `${table}_schedule_preset_check`]);
    }
    await knex.schema.alterTable('agents', (t) => {
        t.timestamp('schedule_next_run_at', { useTz: true }).nullable();
        t.timestamp('schedule_due_at', { useTz: true }).nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable('agents', (t) => {
        t.dropColumn('schedule_next_run_at');
        t.dropColumn('schedule_due_at');
    });
    for (const table of ['agents', 'marketplace_agents']) {
        await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, `${table}_git_chain_check`]);
        await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [table, `${table}_schedule_preset_check`]);
        await knex.schema.alterTable(table, (t) => {
            for (const c of ['requires_item', 'git_commit', 'git_push', 'git_open_pr', 'schedule_enabled', 'schedule_preset', 'schedule_time_of_day', 'schedule_weekday', 'schedule_cron_expression']) t.dropColumn(c);
        });
    }
}
