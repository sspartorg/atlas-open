import { readdirSync } from 'node:fs';
import Knex from 'knex';
import config, { MIGRATIONS_DIR } from './knex-config.js';

// atlas-open 1.0.0 shipped migrations 001-020; they were squashed into one
// baseline (ADR 0032). A DB that recorded a file that no longer exists can't
// be upgraded in place, so say how to reset it instead of letting knex die
// with "The migration directory is corrupt".
async function refuseSquashedHistory(knex: Knex.Knex): Promise<void> {
    if (!(await knex.schema.hasTable('_knex_migrations'))) return;
    const files = new Set(readdirSync(MIGRATIONS_DIR));
    const rows = await knex<{ name: string }>('_knex_migrations').select('name');
    const gone = rows.map((r) => r.name).filter((n) => !files.has(n));
    if (gone.length === 0) return;
    console.error(
        `[db] This database was created by atlas-open 1.0.0 or earlier (it recorded ${gone.join(', ')}).\n` +
            '[db] That migration history was squashed into a single baseline, so it cannot be upgraded in place.\n' +
            '[db] Back up anything you need, then reset it: `pnpm db:down:purge && pnpm dev`.'
    );
    process.exit(1);
}

async function main(): Promise<void> {
    const action = process.argv[2] ?? 'latest';
    const knex = Knex(config);
    try {
        await refuseSquashedHistory(knex);
        if (action === 'latest') {
            const [batch, migrations] = await knex.migrate.latest();
            if ((migrations as string[]).length === 0) {
                console.log('[db] schema is already up to date');
            } else {
                console.log(`[db] applied batch ${batch}:`);
                for (const m of migrations as string[]) console.log(`  - ${m}`);
            }
        } else if (action === 'rollback') {
            const [batch, migrations] = await knex.migrate.rollback(undefined, false);
            console.log(`[db] rolled back batch ${batch}:`);
            for (const m of migrations as string[]) console.log(`  - ${m}`);
        } else if (action === 'status') {
            const completed = await knex.migrate.list();
            console.log('[db] completed:', completed[0]);
            console.log('[db] pending:  ', completed[1]);
        } else {
            console.error(`Unknown action: ${action} (expected: latest | rollback | status)`);
            process.exit(2);
        }
    } finally {
        await knex.destroy();
    }
}

void main().catch((err) => {
    console.error('[db] migration failed:', err);
    process.exit(1);
});
