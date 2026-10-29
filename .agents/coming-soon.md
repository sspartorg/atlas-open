# Coming Soon / Stubbed Features

Single source of truth for everything that currently lies about being functional. Every stub has: where it lives, what it claims to do, what's missing, and which page doc covers it.

When a stub is shipped (or removed), delete its row here AND update the page doc's "Coming soon on this page" section.

---

## UI elements that toast / disable instead of working

| Feature | Location (file:line) | Page doc | Trigger UI | What it should do | Blocking on |
|---|---|---|---|---|---|

None today. The last three — the SSH key radio, the Prompt tab formatting toolbar and Search's **Create a Task / Sub-task** button — were **removed** from the UI for launch (not shipped); add them back as rows only when a control that toasts or disables reappears.

---

## Notes on simulated mode

`packages/api/src/services/agent-runner.ts:197` — when `ATLAS_AI_ENABLED !== 'true'`, agent-runner emits canned output instead of spawning the real CLI. The simulated `output_text` is prefixed with the literal marker `[SIMULATED — set ATLAS_AI_ENABLED=true to use real CLI]`. The UI surfaces this state in three places so it can never be mistaken for real output:

- A "Simulated" pill in the topbar when `ai_enabled === false` (visible across the whole app).
- A "Simulated" chip on the run-detail hero next to the status pill.
- A small "Simulated" chip next to each simulated row in the agent's Runs tab.

Detection lives at `packages/web/src/utils/isSimulatedRun.ts`: sniffs `output_text.startsWith('[SIMULATED')` for completed runs, falls back to the global `ai_enabled === false` flag for queued / in-progress runs without output yet. The flag is exposed at `GET /api/settings` (`ai_enabled: boolean`, sourced from `process.env.ATLAS_AI_ENABLED` at every read — never persisted).

This is intentional, not a stub; it's used so devs can play with the app without burning CLI credits. To use the real CLI: set `ATLAS_AI_ENABLED=true` in `packages/api/.env` and restart the API. New runs will spawn the real `claude` / `copilot` binary; old simulated runs keep their `[SIMULATED …]` chip because the marker persists in their `output_text`.

---

## Not in this edition

These are features of the commercial Atlas, not stubs: Atlas Open has no UI for them and they are not planned here. Do not add rows for them above.

Workflows (graph builder, chains of specialised agents, pass/fail loops), script steps, sub-task fan-out, owner gates, scheduled workflows, the 18-agent SDLC pipeline catalog, workflow templates and marketplace publishing, workflow evals, CI follow-through auto-fix, team config sync, workflow analytics.

---

## How to add a new entry here

1. Find or write the stub trigger in the UI.
2. Add a row to the table above with: feature name · file:line · page doc link · trigger description · intended behavior · what's blocking it.
3. Add a one-liner under the affected page doc's "Coming soon on this page" section that links back here.

---

## Sweep — 2026-09-20 (campaign task-21)

Four rows were **deleted, not re-dated**: *Verify credential*, *Check expiries (bulk)*, *Bulk edit / assign on Project Detail* and the external-notification *Chat-ID detect* button. None of those controls exists in the source any more — they were **removed**, not deferred, and their `Location` columns pointed at code that had moved on. `CredentialRowMenu.tsx:14-23` now has exactly Edit and Delete; `Credentials.tsx:182-194` has only Add credential.

This is the sweep `conventions.md` prescribes when a UI file is deleted, and it had not been run — the same drift the B14 autonomous-tab rip-out produced. A stale row here is worse than a missing one: the triage rule tells a tester *"a stub is not a bug"*, so a row for a deleted control teaches them to ignore a real absence.

**0 rows remain** (the table above) — the last three were removed from the UI for launch. Anything citing this file's count should use that number.
