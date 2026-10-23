import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { GUARDRAIL_SCRIPT_SEEDS, runSeed } from './seed.js';
import { db } from './kysely-client.js';
import { marketplaceService } from '../services/marketplace.js';
import { loadCatalog } from '../marketplace/catalog-loader.js';
import { truncateAll } from '../../tests/_pg-db.js';

const BASELINE_SQL = readFileSync(
    resolve(__dirname, 'migrations', '001_baseline.sql'),
    'utf8',
);

describe('baseline SQL guardrails', () => {
    it('seeds the global no-test-execution guardrail row', () => {
        // The baseline SQL contains the INSERT for `seed-net-no-test-execution`
        // — a single source of truth that the constitution composer prepends
        // to every agent's compiled prompt at runtime.
        expect(BASELINE_SQL).toContain("'seed-net-no-test-execution'");
        expect(BASELINE_SQL).toContain("'side_effects_network'");
        expect(BASELINE_SQL).toMatch(
            /seed-net-no-test-execution.*side_effects_network.*Run the project test suite only inside the worktree Atlas provisioned/s,
        );
        // Severity must be `block`, not `warn` or `ask_owner` — the rule is
        // categorical, not negotiable.
        expect(BASELINE_SQL).toMatch(/seed-net-no-test-execution[^\n]*'block'/);
    });
});

// 2026-06-04 — runSeed never creates rows in `agents`. The on-disk catalog
// is synced into `marketplace_agents` (so the Marketplace UI lists every
// entry as "Install"); users install what they need via
// `POST /api/marketplace/agents/:id/install`. This reverses the prior
// "B17 idempotent top-up" contract — auto-installing every catalog entry
// on every boot resurrected agents the Owner had explicitly deleted. See
// `.claude/plans/there-is-a-problem-zazzy-rivest.md`.
describe('runSeed — agents table is owned by marketplace install, not the seed', () => {
    beforeEach(async () => {
        await truncateAll();
    });

    it('leaves the agents table empty on a fresh install', async () => {
        await runSeed();
        const rows = await db.selectFrom('agents').select('id').execute();
        expect(rows).toEqual([]);
    });

    it('still syncs the on-disk catalog into marketplace_agents', async () => {
        await runSeed();
        const catalog = await db.selectFrom('marketplace_agents').select('id').execute();
        expect(catalog.length).toBe(loadCatalog().length);
        expect(catalog.length).toBeGreaterThan(0);
    });

    it('carries every manifest\'s cli, model and effort into marketplace_agents', async () => {
        // `effort` used to be absent from the seed row while the column
        // defaults to 'medium' and `install` copies that default onto the
        // agent — so the manifest field was dead config and the entire fleet
        // ran at 'medium' whatever the catalog declared. `effort` is the one
        // dial that changes how many turns an agent takes, so a silent
        // fallback here is the difference between choosing it and only
        // appearing to.
        await runSeed();
        const rows = await db
            .selectFrom('marketplace_agents')
            .select(['id', 'cli', 'model', 'effort'])
            .execute();
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const entry of loadCatalog()) {
            const row = byId.get(entry.manifest.id);
            expect(row, `${entry.manifest.id} missing from marketplace_agents`).toBeDefined();
            expect(row!.cli).toBe(entry.manifest.cli);
            expect(row!.model).toBe(entry.manifest.model);
            expect(row!.effort).toBe(entry.manifest.effort);
        }
    });

    it('does not resurrect an agent the Owner deleted (the bug this plan fixes)', async () => {
        await runSeed();
        await marketplaceService.install('agent-knowledge-base');
        // Hard-delete via the same path the API DELETE handler uses
        // (services/agents.ts:517). FKs CASCADE clean up dependents.
        await db.deleteFrom('agents').where('id', '=', 'agent-knowledge-base').execute();
        await runSeed();
        const row = await db
            .selectFrom('agents')
            .select('id')
            .where('id', '=', 'agent-knowledge-base')
            .executeTakeFirst();
        expect(row).toBeUndefined();
    });

    it('does not touch agents the Owner edited (prompt_version > 1)', async () => {
        await runSeed();
        await marketplaceService.install('agent-solo');
        const ownerEdit = '# OWNER-EDITED PROMPT — do not overwrite';
        await db
            .updateTable('agents')
            .set({ prompt_md: ownerEdit, prompt_version: 5 })
            .where('id', '=', 'agent-solo')
            .execute();
        await runSeed();
        const row = await db
            .selectFrom('agents')
            .select(['prompt_md', 'prompt_version'])
            .where('id', '=', 'agent-solo')
            .executeTakeFirst();
        expect(row?.prompt_md).toBe(ownerEdit);
        expect(row?.prompt_version).toBe(5);
    });
});

// The seeded `guardrail_scripts` rows. `constitution-assembler` writes each
// as `.atlas/scripts/{bash,powershell}/check-<id>.{sh,ps1}` per worktree.
// Idempotent via ON CONFLICT (id) DO UPDATE.
describe('GUARDRAIL_SCRIPT_SEEDS', () => {
    const EXPECTED_IDS = [
        'prereqs',
        // Gone: commit-discipline (002, agents never commit); po-writer-output,
        // architect-spec-md, qa-writer-csv, check-automation-tests (003, the
        // pipeline roles they checked do not exist in this edition);
        // coder-tests-green and the gate-* scripts (ADR 0024, they guessed at
        // the customer's stack).
    ] as const;

    it('exports every seed with the canonical ids', () => {
        expect(GUARDRAIL_SCRIPT_SEEDS).toHaveLength(EXPECTED_IDS.length);
        const ids = GUARDRAIL_SCRIPT_SEEDS.map((s) => s.id).sort();
        expect(ids).toEqual([...EXPECTED_IDS].sort());
    });

    it('every seed carries non-empty body_sh and body_ps1', () => {
        for (const seed of GUARDRAIL_SCRIPT_SEEDS) {
            expect(seed.body_sh.length, `${seed.id} body_sh`).toBeGreaterThan(0);
            expect(seed.body_ps1.length, `${seed.id} body_ps1`).toBeGreaterThan(0);
        }
    });

    it('every PowerShell body is pure ASCII (PS 5.1 parser compat)', () => {
        for (const seed of GUARDRAIL_SCRIPT_SEEDS) {
            for (let i = 0; i < seed.body_ps1.length; i++) {
                const c = seed.body_ps1.charCodeAt(i);
                expect(
                    c,
                    `${seed.id} body_ps1 char ${i} (${JSON.stringify(seed.body_ps1.slice(Math.max(0, i - 10), i + 10))}) must be ASCII`,
                ).toBeLessThan(128);
            }
        }
    });
    describe.skipIf(process.platform === 'win32')('prereqs', () => {
        const runPrereqs = (cwd: string) => {
            const body = GUARDRAIL_SCRIPT_SEEDS.find((s) => s.id === 'prereqs')?.body_sh ?? '';
            writeFileSync(join(cwd, 'prereqs.sh'), body);
            try {
                return { code: 0, out: execFileSync('bash', ['prereqs.sh', 'ATL-1'], { cwd, encoding: 'utf8' }) };
            } catch (err) {
                const e = err as { status?: number; stdout?: string };
                return { code: e.status ?? 1, out: e.stdout ?? '' };
            }
        };

        // Agents never commit, so the tree is dirty at the end of every run
        // that changed something. The gate must not call that a gap.
        it('passes on a dirty tree once the run is staged', () => {
            const dir = mkdtempSync(join(tmpdir(), 'prereqs-'));
            execSync('git init -q && touch changed.txt', { cwd: dir });
            mkdirSync(join(dir, '.atlas'));
            writeFileSync(join(dir, '.atlas', 'constitution.md'), '# Constitution\n');
            expect(runPrereqs(dir)).toEqual({ code: 0, out: '' });
        });

        it('fails when the constitution was not staged', () => {
            const r = runPrereqs(mkdtempSync(join(tmpdir(), 'prereqs-')));
            expect(r.code).toBe(1);
            expect(r.out).toContain('.atlas/constitution.md missing');
        });
    });

    // The budget exists so an embedded shell script cannot quietly become a
    // program. Since ADR 0024 every script left here checks an Atlas artifact,
    // and none of them has a reason to grow: a check that needs branching over
    // what the project happens to use belongs in a checker agent's prompt,
    // where it can read the repo instead of guessing.
    const LINE_BUDGET = 80;

    it('each script body is within its line budget', () => {
        for (const seed of GUARDRAIL_SCRIPT_SEEDS) {
            const shLines = seed.body_sh.split('\n').length;
            const psLines = seed.body_ps1.split('\n').length;
            expect(shLines, `${seed.id} bash lines`).toBeLessThanOrEqual(LINE_BUDGET);
            expect(psLines, `${seed.id} powershell lines`).toBeLessThanOrEqual(LINE_BUDGET);
        }
    });

    // A Windows project must not silently get a weaker check than a Unix one.
    // The ps1 for one script ran two of the nine checks its bash sibling ran,
    // and nothing caught it because no test compared them. Parity is asserted
    // on executable tokens rather than prose, so a script cannot pass by
    // DESCRIBING a check it does not run.
    const withoutComments = (body: string) =>
        body
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');

    it('every script body is non-trivial on both platforms', () => {
        for (const seed of GUARDRAIL_SCRIPT_SEEDS) {
            expect(withoutComments(seed.body_sh).trim().length, `${seed.id} bash`).toBeGreaterThan(40);
            expect(withoutComments(seed.body_ps1).trim().length, `${seed.id} powershell`).toBeGreaterThan(40);
        }
    });

    describe('runSeed seeds guardrail_scripts rows', () => {
        beforeEach(async () => {
            await truncateAll();
        });

        it('inserts every canonical row on a fresh DB', async () => {
            await runSeed();
            const rows = await db
                .selectFrom('guardrail_scripts')
                .select(['id', 'name', 'body_sh', 'body_ps1'])
                .where('id', 'in', [...EXPECTED_IDS])
                .execute();
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const id of EXPECTED_IDS) {
                const row = byId.get(id);
                expect(row, `${id} should be seeded`).toBeDefined();
                expect(row?.body_sh.length).toBeGreaterThan(0);
                expect(row?.body_ps1.length).toBeGreaterThan(0);
            }
        });

        it('is idempotent — running twice keeps exactly one row per id', async () => {
            await runSeed();
            await runSeed();
            const rows = await db
                .selectFrom('guardrail_scripts')
                .select(['id'])
                .where('id', 'in', [...EXPECTED_IDS])
                .execute();
            expect(rows).toHaveLength(EXPECTED_IDS.length);
            const ids = rows.map((r) => r.id).sort();
            expect(ids).toEqual([...EXPECTED_IDS].sort());
        });

        it('ON CONFLICT updates the body when the seed source changes', async () => {
            await runSeed();
            // Stomp a body to simulate stale on-disk data.
            await db
                .updateTable('guardrail_scripts')
                .set({ body_sh: 'STALE', body_ps1: 'STALE' })
                .where('id', '=', 'prereqs')
                .execute();
            await runSeed();
            const row = await db
                .selectFrom('guardrail_scripts')
                .select(['body_sh', 'body_ps1'])
                .where('id', '=', 'prereqs')
                .executeTakeFirstOrThrow();
            expect(row.body_sh).not.toBe('STALE');
            expect(row.body_ps1).not.toBe('STALE');
            const seed = GUARDRAIL_SCRIPT_SEEDS.find((s) => s.id === 'prereqs')!;
            expect(row.body_sh).toBe(seed.body_sh);
            expect(row.body_ps1).toBe(seed.body_ps1);
        });
    });
});

// Why no `gate-*` script is tested here any more (ADR 0024).
//
// The golden set's `frontend-only` fixture existed to exercise `gate-visual`,
// and on the first v4 run the gate SKIPPED it: the sandbox is a server-rendered
// Express app that builds its HTML in `src/render.js`, and the detection was an
// extension list — tsx|jsx|vue|svelte|css|scss|less|html — that no `.js` file
// can ever match. Every server-rendered app had no visual checking at all,
// silently, while the gate reported a pass. `gate-coverage` looked for a
// COVERAGE script only and, finding none, skipped the measurement AND the test
// run, on a sandbox that declares `"test": "node --test"`.
//
// Both were fixed, and both fixes were more guessing: a wider regex, a second
// script-name list. The fix that holds is to stop guessing — a checker agent
// reads the repo and names the command. What used to be tested here as bash
// behaviour is now tested as routing (`gate-check-routing.test.ts`) and as
// engine behaviour (`workflow-engine.integration.test.ts`), because that is
// where the remaining logic lives.
