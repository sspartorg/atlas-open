import { db } from './kysely-client.js';
import { loadCatalog, type CatalogEntry } from '../marketplace/catalog-loader.js';
import { sourcesFor, type RegulationSource } from '../agents/sources/regulations-matrix.js';

// Theme 09 — defensive boot check that the regulations matrix has
// at least one source per project_type × region we ship. Catches
// matrix typos in the seed module (which is exercised by `pnpm
// db:seed` on a fresh DB) rather than at agent dispatch time.
function assertRegulationsMatrixHealthy(): void {
    const sample: RegulationSource[] = sourcesFor('saas', 'EU');
    if (sample.length === 0) {
        throw new Error('regulations-matrix: saas:EU returned no sources');
    }
}

// Sync the on-disk catalog (packages/api/src/marketplace/catalog/) into the
// marketplace_agents table. Idempotent: every run overwrites the row from the
// manifest, so `version` is whatever `manifest.json` declares — it is NOT
// derived from content_hash. The hash is still computed and stored, but it
// stopped driving version bumps because a hash that moved on cosmetic edits
// produced "upgrade available" banners with nothing to apply.
//
// Existing local agents are NEVER mutated here, even on catalog upgrade; the
// UI surfaces the diff and the Owner accepts. Owner edits on a local agent
// never break the back-link — they simply mean the local row diverges from the
// catalog. Detach (UI action) is the only way to clear the link.
//
// There is no second phase. Auto-installing catalog entries into `agents` was
// removed because it resurrected agents the Owner had deleted; see the note on
// `runSeed` below.
async function syncMarketplaceCatalog(): Promise<CatalogEntry[]> {
    const catalog = loadCatalog();
    if (catalog.length === 0) return [];

    const existing = await db
        .selectFrom('marketplace_agents')
        .select(['id', 'content_hash', 'version'])
        .execute();
    const existingById = new Map(existing.map((r) => [r.id, r]));

    await db.transaction().execute(async (trx) => {
        for (const entry of catalog) {
            const prior = existingById.get(entry.manifest.id);
            // Versioning is manifest-controlled: the catalog version always
            // equals the value the author declared in manifest.json. Bumping a
            // version is now an explicit edit (e.g. 1 -> 2) made alongside the
            // content change you want to publish - not a side effect of any
            // byte changing in the bundle. This kills the "upgrade available
            // but nothing to apply" banner that the old content_hash auto-bump
            // produced for metadata-only / memory.md edits (the bump surface
            // was wider than the 5 fields the upgrade modal can apply).
            // content_hash is still computed and stored below for future
            // change-detection use; it just no longer drives the version.
            const nextVersion = entry.manifest.version;
            const row = {
                id: entry.manifest.id,
                name: entry.manifest.name,
                category: entry.manifest.category,
                cli: entry.manifest.cli,
                model: entry.manifest.model,
                // `effort` was missing here while `marketplace_agents.effort`
                // defaults to 'medium' and `install` copies that default onto
                // the agent — so the manifest field was dead config and every
                // installed agent ran at 'medium' no matter what the catalog
                // declared. It is the one dial that changes how many turns an
                // agent takes, which makes this the difference between choosing
                // an effort and only appearing to.
                effort: entry.manifest.effort,
                framework: entry.manifest.framework,
                prompt_md: entry.prompt_md,
                description: entry.manifest.description,
                designation: entry.manifest.designation,
                accent_color: entry.manifest.accent_color,
                sort_order: entry.manifest.sort_order,
                glyph: entry.manifest.glyph,
                role_id: entry.manifest.role_id,
                status: entry.manifest.status,
                kind_slug: entry.manifest.kind_slug,
                settings_json: entry.manifest.settings_json,
                memory_cadence: entry.manifest.memory_cadence,
                memory_template_md: entry.memory_md,
                summary: entry.manifest.summary,
                version: nextVersion,
                content_hash: entry.content_hash,
                published_at: entry.manifest.published_at,
                updated_at: new Date().toISOString(),
            };

            if (prior == null) {
                await trx.insertInto('marketplace_agents').values(row).execute();
            } else {
                await trx.updateTable('marketplace_agents').set(row).where('id', '=', row.id).execute();
                await trx
                    .deleteFrom('marketplace_agent_checklists')
                    .where('marketplace_agent_id', '=', row.id)
                    .execute();
            }

            if (entry.checklists.length > 0) {
                await trx
                    .insertInto('marketplace_agent_checklists')
                    .values(
                        entry.checklists.map((c) => ({
                            marketplace_agent_id: row.id,
                            label: c.label,
                            sort_order: c.sort_order,
                            required: c.required,
                        }))
                    )
                    .execute();
            }
        }
    });

    return catalog;
}

// ─── Guard-rail scripts ──────────────────────────────────────────────
//
// `constitution-assembler.ts` writes every `guardrail_scripts` row to
// `.atlas/scripts/{bash,powershell}/check-<id>.{sh,ps1}` per worktree. Each
// script takes the item id as `$1` (`$args[0]` on PowerShell), exits 0 on
// green, or exits 1 with a numbered gap list on stdout.
//
// Only `prereqs` ships. The PO Writer / Architect / QA Writer / Automation
// gates that sat beside it checked the output of pipeline roles this edition
// does not have; migration 003 deletes their rows from existing installs.
//
// A script here checks an ATLAS artifact, never the customer's stack (ADR
// 0024): Atlas cannot know what kind of project it has been pointed at, so a
// check that greps for a file extension or picks a number belongs in the
// agent's prompt, not in bash.
//
// Idempotency: ON CONFLICT (id) DO UPDATE. Edits to these bodies propagate to
// existing dbs on next `runSeed()`.
//
// PowerShell encoding: ASCII-only (PS 5.1 reads non-BOM UTF-8 as ANSI and
// parser-errors on non-ASCII). No em dashes, curly quotes, or arrow glyphs in
// any `.ps1` body.

interface GuardrailScriptSeed {
    id: string;
    name: string;
    description: string;
    sort_order: number;
    body_sh: string;
    body_ps1: string;
}

// No clean-tree check: agents leave their changes uncommitted and Atlas
// commits them when the run ends, so a dirty tree is the normal state.
export const GUARDRAIL_SCRIPT_SEEDS: GuardrailScriptSeed[] = [
    {
        id: 'prereqs',
        name: 'Worktree prereqs',
        description:
            'Verifies the run was staged: the .atlas directory and .atlas/constitution.md exist in the worktree.',
        sort_order: 100,
        body_sh: `#!/usr/bin/env bash
# Worktree prereqs gate. $1 is the item id (ignored here).
set -u
gaps=""
n=0
if [ ! -d .atlas ]; then
    n=$((n+1))
    gaps="$gaps$n. .atlas directory missing
"
fi
if [ ! -f .atlas/constitution.md ]; then
    n=$((n+1))
    gaps="$gaps$n. .atlas/constitution.md missing
"
fi
if [ -z "$gaps" ]; then exit 0; fi
printf "prereqs:\\n%s" "$gaps"
exit 1
`,
        body_ps1: `# Worktree prereqs gate. $args[0] is the item id (ignored here).
$ErrorActionPreference = 'Continue'
$gaps = New-Object System.Collections.ArrayList
if (-not (Test-Path -LiteralPath '.atlas' -PathType Container)) {
    [void]$gaps.Add('.atlas directory missing')
}
if (-not (Test-Path -LiteralPath '.atlas/constitution.md' -PathType Leaf)) {
    [void]$gaps.Add('.atlas/constitution.md missing')
}
if ($gaps.Count -eq 0) { exit 0 }
Write-Output 'prereqs:'
$i = 0
foreach ($g in $gaps) { $i++; Write-Output ("{0}. {1}" -f $i, $g) }
exit 1
`,
    },
];

async function seedGuardrailScripts(): Promise<void> {
    const now = new Date().toISOString();
    for (const s of GUARDRAIL_SCRIPT_SEEDS) {
        await db
            .insertInto('guardrail_scripts')
            .values({
                id: s.id,
                name: s.name,
                description: s.description,
                body_sh: s.body_sh,
                body_ps1: s.body_ps1,
                sort_order: s.sort_order,
            })
            .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                    name: s.name,
                    description: s.description,
                    body_sh: s.body_sh,
                    body_ps1: s.body_ps1,
                    sort_order: s.sort_order,
                    updated_at: now,
                }),
            )
            .execute();
    }
}

// `runSeed` is the single entry point for `pnpm db:seed`. It does ONE thing:
// sync the on-disk catalog (`packages/api/src/marketplace/catalog/`) into the
// `marketplace_agents` table. Idempotent — each entry's `version` is taken
// verbatim from its `manifest.json` and overwritten on every run; content_hash
// is stored but does not drive it.
//
// It NEVER creates rows in the `agents` table. Agents exist only when the
// Owner installs them via `POST /api/marketplace/agents/:id/install`
// (`marketplaceService.install`). The earlier auto-install-on-boot path
// resurrected agents the Owner had deleted — see
// `.claude/plans/there-is-a-problem-zazzy-rivest.md`. Per-boot reconciliation
// of seed-shaped prompts on agents the Owner did install lives in
// `services/agent-defaults-sync.ts`.
export async function runSeed(): Promise<void> {
    assertRegulationsMatrixHealthy();

    const catalog = await syncMarketplaceCatalog();

    // No `agent_templates` rows are seeded: the spec / plan / tasks /
    // sub-task / qa-plan templates were the pipeline roles' and no shipped
    // agent reads `.atlas/templates/`. Migration 003 deletes them.
    await seedGuardrailScripts();

    console.log(
        `[db] seed: marketplace catalog synced (${catalog.length} entries) + ${GUARDRAIL_SCRIPT_SEEDS.length} guardrail scripts`
    );
}
