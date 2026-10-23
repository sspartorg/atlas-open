import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Knex } from 'knex';

// Baseline schema for Atlas Open, squashed from migrations 001-020 on
// 2026-10-23 (ADR 0032). It carries only what this edition uses: the team
// config, published-workflow and workflow-builder leftovers are gone.
// Supersedes the squashes of ADR 0025 and ADR 0019. The DDL lives in the
// sibling `001_baseline.sql` so future schema diffs are readable SQL rather
// than a JS template literal.
//
// Regenerate the sibling file in two passes against a clean Postgres DB with
// every migration applied:
//   1. `pg_dump --schema-only --no-owner --no-acl
//      --exclude-table='_knex_migrations*'`.
//   2. `pg_dump --data-only --column-inserts --no-owner --no-acl
//      -t cli_models -t roles -t guardrail_rules -t settings -t workflows`, appended before
//      the trailing "dump complete" comment.
//
// Then strip from the COMBINED result, not just from pass 1:
//   - every `\restrict` / `\unrestrict` line. Both passes emit them. psql
//     treats them as meta-commands and swallows them, so verifying with
//     `psql -f` hides the problem; knex sends the file as SQL and dies with
//     `syntax error at or near "\"`.
//   - every column-0 `SET ...` and `SELECT pg_catalog.set_config(...)` line.
//     `set_config('search_path', '', false)` is the dangerous one: it blanks
//     the search path for the rest of the session, and knex's own follow-up
//     `insert into "_knex_migrations"` then fails with `relation
//     "_knex_migrations" does not exist`. Every object in the dump is
//     schema-qualified, so dropping the preamble is safe.
//
// Verify by running THIS FILE through `run-migrations.ts latest` against a
// second clean DB and diffing both dumps — not by `psql -f`.
//
// Pass 2 is not optional. `--schema-only` emits no rows, and a baseline
// without them installs with no CLI models, no roles, no guard-rail rules and
// no settings singleton to onboard into, and no built-in `solo` workflow every
// run hangs off. The 2026-10-23 regeneration carried 48 rows (22 cli_models,
// 14 guardrail_rules, 10 roles, 1 settings, 1 workflows).

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function up(knex: Knex): Promise<void> {
    const sql = readFileSync(join(__dirname, '001_baseline.sql'), 'utf8');
    await knex.raw(sql);
}

export async function down(_knex: Knex): Promise<void> {
    // Baseline rollback is intentionally a no-op. Use `pnpm db:down:purge` to
    // wipe the volume; reversing every CREATE in dependency order is brittle
    // and we never need it for a single-owner local dev DB.
}
