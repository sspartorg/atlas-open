# 0032. Atlas Open Gets Its Own Baseline and Its Own Local Stack

**Date:** 2026-10-23
**Status:** Accepted. Supersedes [ADR 0025](0025-third-baseline-squash-and-catalog-v1.md) for this edition.

## Context

Atlas Open 1.0.0 shipped the commercial edition's migrations 001–019 plus its own `020_solo_runs.ts`. Several of those exist only for features this edition removed (team config sync, the workflow builder and marketplace, CI follow-through, gate logs). It also shipped the commercial edition's local defaults, unchanged: Postgres container `atlas-postgres` on 5500 with volume `atlas-pg`, MCP on 4500, e2e on 6001/6010, the `atlas_test` / `atlas_e2e` / `atlas_perf` / `atlas_guide` DBs and the `~/.config/Atlas` data folder. On a machine with both checkouts the two editions shared one Postgres container, so:

- one edition's e2e setup force-dropped the other's DB;
- `020_solo_runs.ts` landed in the shared `atlas_test` history and broke the other edition's test migrations;
- `db:down:purge` from either repo wiped both repos' data.

## Decision

- **Own stack.** Every local default moves to its own range. Dev runs on web 4300, API 4301 and MCP 4600, with Postgres in container `atlas-open-postgres` on 5600 (volume `atlas-open-pg`, compose project `atlas-open`, DB `atlas_open`). Prod uses 5300/5301 and 5610 (`atlas_open_prod`), and HTTPS 5643. e2e runs on 7001/7010/7091/7094 (`atlas_open_e2e`), perf on 4800/4801/4810 (`atlas_open_perf`), guide on 7010/7001/4820 (`atlas_open_guide`), and unit tests use `atlas_open_test`. Data lives in `~/.config/AtlasOpen` (`%APPDATA%\AtlasOpen`). Temp folders are prefixed `atlas-open-`.
- **Own baseline.** `001_baseline.{ts,sql}` is regenerated from 001–020 with the commercial-only schema dropped: the `team_config` and `published_workflows` tables, five unused `workflows` columns, `projects.default_workflow_id`, `item_external_links.ci_fix_attempts` and `run_gate_results.log_path`. Files `002`–`020` are deleted. `team_managed` stays because it is on the `@atlas/shared` wire types.
- **Refuse old histories.** `run-migrations.ts` exits with a reset instruction when `_knex_migrations` names a file that no longer exists.

## Consequences

- Both editions run side by side with no shared port, container, volume, DB or data folder.
- A 1.0.0 install must reset (`pnpm db:down:purge && pnpm dev`) or rewrite `_knex_migrations` by hand (`.agents/api-surface.md` §"Existing-DB cleanup"). Its old data sits in the commercial-edition container (`atlas-postgres`) and is left there.
- The user-scope MCP entry is still named `atlas` (agent prompts call `mcp__atlas__*`). Pointing it at 4600 replaces a commercial-edition entry on the same machine. Item-attached runs are unaffected because they pass their own `--mcp-config`.
- The baseline was verified by running it through `run-migrations.ts` on a clean DB and diffing the dump against the pruned 20-migration DB: identical.
