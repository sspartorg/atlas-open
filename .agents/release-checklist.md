# Release-readiness checklist — Atlas Open (this laptop)

## Final state (2026-10-29, branch `chore/release-readiness`)

| Suite | Result |
|---|---|
| `pnpm gate` (typecheck ×5, lint, knip, coverage, build, bundle budget) | **green** — shared 260, mcp 134, web 4335, api 3338 (+3 skipped) |
| `pnpm e2e` (hermetic) | **723 passed, 0 failed** (374 skipped: `@mobile`/`@ipad` tags, visual baselines, live specs without their flags); API log 0 unhandled, 0 restarts |
| `e2e/live/task-to-pr-live.spec.ts`, real `claude` + `gh` + GitHub + Jira | **21/21 in one run** (16.9 min, $1.78): secrets, owner MCP, happy path, question → reply, no-change Task, Stop, API restart, one at a time, expired token, stale branch, Postgres restart, Terminal, Jira bridge, all 6 marketplace agents + 2 via Tasks |
| `pnpm e2e:functional` / `pnpm e2e:state-transitions` (against `pnpm dev`) | **29/29**, **10/10** |
| `pnpm e2e:live` (quiet hours on the real clock: Teams + Telegram; real Chrome + FCM push) | **3/3** — the Chrome push spec hung once in `pushManager.subscribe` (Google's push service) and passed on the rerun: test push and a run park both shown |
| Telegram (Atlas's own test send, real bot) | PASS |
| `pnpm prod` | PASS (after R18, R19) |

**Not covered here, and why**
- **Tier 1 clean install** — `bootstrap.ps1` needs an elevated shell; waiting on the Owner to run it from `%TEMP%\atlas-fresh`. Its four bugs (R2–R5) were found by reading and reproducing each step, and fixed.
- **Copilot CLI** — not installed on this laptop. Copilot itemless runs still read `~/.copilot/mcp-config.json` (see R10).
- **Multi-repo Task live** — needs a second sandbox repo; creating one was blocked by the permission classifier. Covered by `workflow-engine.integration.test.ts` with real git.
- **Teams** — no credentials; tested only against a local webhook receiver (hermetic notification specs and `pnpm e2e:live`'s quiet-hours spec).
- **`prod:https`** — Caddy not installed (optional).

**For the Owner's own machine** (gitignored files / existing containers, not changed by this branch)
- `.env.prod`: set `DATABASE_URL=postgres://atlas:atlas@127.0.0.1:5610/atlas_open_prod` (R18).
- The existing Postgres containers still publish on 0.0.0.0; `docker rm -f atlas-open-postgres atlas-open-postgres-prod && pnpm db:up` recreates them on 127.0.0.1 (data stays in the volumes).

## Context
The suites are 100% green, but green only covers what they test. Before publishing and marketing,
every user-facing scenario must be proven on this Windows laptop. Gaps found while planning:
- **The core Task → agent → PR flow has no live automated test.** e2e uses `e2e/fixtures/fake-claude.js`,
  and `e2e/live/` only has `chrome-push-live` and `quiet-hours-live`.
- **One-click install** (`scripts/bootstrap.ps1`) has never been run from a fresh clone.
- **Jira / Telegram / Copilot** are only tested against mocks.
- **e2e skips 325 specs** (mobile/ipad + visual baselines): need to confirm none of them hide a real gap.
- `pnpm prod` / HTTPS mode is not in the gate.

Rules for the session: token-lean (dot/line reporters, `tail` of failures only, no full logs in context);
every failure gets a root-cause fix plus a regression test (per memory); live runs only, `ATLAS_AI_ENABLED=true`;
no edits to `packages/*/src` while `pnpm e2e` runs (testing.md trap).

## Deliverable
A new `.agents/release-checklist.md`: the tiers below as checkboxes, each with its command, PASS/FAIL,
and a link to the fix commit. Work happens on branch `chore/release-readiness`, with one PR at the end.

## Tier 0 — Baseline (cheap, run first)
- [ ] `pnpm gate` (typecheck, lint, knip, coverage) → record counts
- [ ] `pnpm e2e --reporter=dot` → record pass/skip; list the skip reasons by tag and confirm each is intentional
- [ ] `pnpm e2e:functional`, `pnpm e2e:state-transitions`
- [ ] `pnpm doctor` is clean; API log shows 0 restarts and 0 unhandled rejections

## Tier 1 — Clean install (fresh clone in `%TEMP%\atlas-fresh`)
- [ ] First read `bootstrap.ps1` (`Ensure-McpServerDefinitions`, `Ensure-EnvFile`) to confirm it **backs up and merges**
      `~/.claude.json` and `~/.copilot/mcp-config.json`. If it doesn't, back them up manually first.
- [ ] `bootstrap.ps1 -NonInteractive` (admin) → exit 0; then `pnpm dev` → `/api/health` ok, UI loads
- [ ] Rerun bootstrap → stays the same on a second run (no duplicate MCP entries, `.env` keeps its values)
- [ ] README quick-start steps match what actually happened (fix the docs if not)
- [ ] Port conflict: a fresh clone shouldn't clash with the main checkout's DB container/ports, or the README should say how
- [ ] Docker stopped → bootstrap/dev print a clear message, not a stack trace

## Tier 2 — Core flow, live (new `e2e/live/task-to-pr-live.spec.ts`, gated by `E2E_LIVE=1`)
Sandbox: private `sspartorg/atlas-open-sandbox` (created with `gh`), reset to a known commit before each run.
The spec drives the API (plus one UI assertion per step) with real `claude`, using tiny tasks to keep cost low:
- [ ] Happy path: Task → queued → in_progress → agent edits a file → Atlas commits + pushes → PR exists (`gh pr view`) → run page shows steps and changes
- [ ] Agent asks a question → run `waiting_for_owner` → Owner comment resumes it → PR
- [ ] Agent makes no changes (single repo) → must not park as `delivery_failed` with a raw "No commits between" error (suspected from code; verify)
- [ ] Stop mid-run → stays stopped (regression for ff5997b) → Resume works
- [ ] Crash (kill the CLI process) → exactly one automatic retry after 30 s; a second crash parks the run (`step_error`) with a visible reason
- [ ] Concurrency: 2 Tasks queued → only one runs (`MAX_CONCURRENT_AGENTS` = 1), the second starts when the first finishes; a parked run frees the slot but keeps its repo
- [ ] Multi-repo project → one PR per repo touched; untouched repo → no PR
- [ ] API restart mid-run → orphan sweep marks the step `error` ("API restarted before run completed") → retry or park, visible on the run page. Known: the 30 s retry timer is in memory, so a restart during it loses the retry; the 10-min reconcile must then park it
- [ ] No GitHub auth / push rejected → run fails with the reason on the run page, not only in the log
- [ ] Copilot CLI agent: the happy path again with the standalone `copilot` CLI
- [ ] Teardown closes PRs and deletes every `atlas/task/LIV-*` branch in the sandbox
- [x] DB reset against a repo that still has `atlas/task/<KEY>-1` from an earlier install → delivers (T2-STALE)

## Tier 3 — Integrations, live
- [ ] Jira bridge: real JQL source → Tasks imported, assigned to the agent; status mapping writes back (extend `e2e/flows/jira-bridge.spec.ts` with an `E2E_LIVE` variant)
- [ ] Telegram: test message + a real run-finished notification arrives (check through the Bot API `getUpdates`, or I ask you to confirm on your phone)
- [ ] Teams: no credentials. Mark it as "mock-tested only" in the checklist and README
- [ ] Each marketplace agent (AI News, AI Readiness, Jira to Epic, Knowledge Base, Market Research, Regulations): install → run on demand once → output recorded. Most expensive item: run each one once, sequentially
- [ ] MCP: `testing-mcp.md` scripted smoke against a live API; real `claude` CLI uses the Atlas MCP to create a Task

## Tier 4 — Modes and resilience
- [ ] `pnpm prod` and `pnpm prod:https` start, serve the UI, and a live run completes
- [ ] DB container restart while the app runs → it recovers
- [ ] Terminal/CLI sessions with real `claude`: start / pause / resume / stop + PR
- [ ] Secrets: X1 invariant spot-check through raw API responses (no plaintext in list/get)

## Tier 5 — Open owner decisions (from functional-checklist.md)
- [ ] C1 `comments.author_name`: needs your "yes, edit shared"; I'll ask when we get there
- [ ] C2 unseeded SdlcRole slugs: recommend narrowing the union (no content to invent)
- [ ] 3 coming-soon stubs: hide or keep the toast before launch (I'll ask)

## Order and cost control
Tier 0 → 1 → 2 → 3 → 4. Stop and fix at the first red, then rerun only the affected suite, then the full
gate once at the end. Live tests use one-line prompts on the sandbox repo. Marketplace agents run once each.

## Verification (exit criteria)
Every box is ticked or explicitly marked out of scope with a reason. A final `pnpm gate:full` plus
`pnpm e2e:live` are green in one session. `.agents/release-checklist.md` is committed with results, and the PR is opened.

## Findings log (2026-10-29)

| # | Tier | Finding | Status |
|---|---|---|---|
| R1 | 0 | `pnpm gate` red: 2 web tests timed out under coverage (9 s alone, >30 s in parallel). A timed run of the whole suite found ~15 more at 10–22 s. Causes: `userEvent.type` re-rendering big MUI forms per keystroke; name-filtered role queries over 50+ row lists. | Fixed: worst 22.4 s → 3.9 s; no timeout raised, no assertion weakened |
| R2 | 1 | bootstrap.ps1: the "atlas already registered" regex never matched `claude mcp list` output (`atlas:`). | Fixed: `claude mcp get atlas` (as bootstrap.sh) |
| R3 | 1 | bootstrap.ps1: Windows PowerShell 5.1 strips the inner quotes of a JSON arg to a native exe, so `claude mcp add-json` always failed. | Fixed: `claude mcp add --transport http` |
| R4 | 1 | bootstrap.ps1 fallback rewrote `~/.claude.json` via ConvertFrom-Json, which throws on Claude Code's case-variant project keys (`C:/x` and `c:/x`), and would have written a BOM. | Fixed: never rewrite it; print the manual command. JSON writes are BOM-free |
| R5 | 1 | Both bootstraps installed the retired `gh copilot` extension; Atlas spawns the standalone `copilot` (npm @github/copilot). | Fixed in both scripts |
| R6 | docs | README claimed "up to three Tasks run at once"; code is `MAX_CONCURRENT_AGENTS = 1` (ADR 0033). | Fixed |
| R7 | 2 | **Launch blocker.** A PAT credential without the optional human name/email → `GIT_CONFIG_GLOBAL` replaces ~/.gitconfig with a config that has no `[user]` → `git commit` fails "Author identity unknown" → every Task delivers nothing. | Fixed: `buildGitAuth` carries the host's global identity; unit test commits for real |
| R8 | 2 | A failed commit was only a log line nobody reads; delivery pushed on and parked with GitHub's misleading "No commits between main and …". On resume, a failed commit was followed by a worktree reset that discarded the agent's work. | Fixed: delivery parks `Commit failed: <git error>`; resume refuses instead of resetting. Integration test with a failing hook |
| R9 | 2 | Delivery `log` lines: on success they go into the Owner notification (`finishRun`); on failure only `failure` becomes `park_reason`. The commit error was the one reason that never reached `failure`. | Closed by R8: every failing step (commit, push, PR) now sets `failure` with its own error |
| R10 | 3 | Atlas and Atlas Open both register the MCP server as `atlas`. On a machine with both, itemless (marketplace) runs used whichever `atlas` ~/.claude.json names (here: the commercial Atlas on 4500, down). | Fixed: itemless Claude runs get `--mcp-config` with this instance's `atlas` (no strict mode); verified with the real CLI that it overrides the user entry. Copilot itemless runs still read ~/.copilot/mcp-config.json |
| R11 | 1 | `pnpm doctor` said "All prerequisites satisfied" with the Docker engine stopped (`docker --version` only); `db:up` then failed with compose's raw pipe error. Doctor output also carried Node's DEP0190 warning. | Fixed: doctor checks `docker info`, db:up checks it first, both say "Start Docker Desktop" |
| R12 | 2 | A single-repo Task that needed no change opened a PR containing only Atlas's own `.gitignore` commit (`hasChanges` ran for multi-repo only). Found live (sandbox PR #10). | Fixed + integration test; verified live (LIV-3: completed, no PR, Task done) |
| R13 | product | Every Atlas PR adds 5 lines to the user's `.gitignore` ("Atlas scratch" paths) in a separate commit. Intentional, but visible in every PR a new user reviews. | Owner decision (Tier 5) |
| R14 | 2 | An API restart within 30 s of a step error lost the automatic retry: the retry timer lives in memory, the boot sweep only looks at queued/in_progress steps, so the run waited 10 min for reconcile to park it "lost". Found live (LIV-5). | Fixed: boot `resumeLostRetries()` + integration test |
| R15 | 3 | Six marketplace manifests shipped `"status": "inactive"` (per-agent-schedule leftover). Install copies it and `/api/run` refuses inactive agents: a new user's first Run of AI News & co. answered "Agent is not active". | Fixed: manifests ship active (schedules stay off), versions bumped, contract pins it. Existing installs keep their status (upgrade never copies it) |
| R16 | harness | `E2E_SKIP_SETUP=1` runs still killed every PID in `e2e-logs/pids.json` at teardown — a full `pnpm e2e` beside it lost its API mid-suite (or stale, reused PIDs). | Fixed in global-teardown |
| R18 | 1/4 | **Launch blocker.** Both example env files shipped `DATABASE_URL` with no user/password while compose creates the container as atlas/atlas: a copied `.env` (bootstrap's path) failed at `db:wait` ("client password must be a string"). Found by `pnpm prod`. Also: both Postgres ports published on every interface with public default credentials. | Fixed: examples match compose defaults; ports bound to 127.0.0.1 (applies to newly created containers) |
| R19 | 4 | `pnpm prod` never started the web on Windows: `serve.mjs` spawned `vite`, a .cmd shim there (ENOENT). | Fixed: runs vite's bin/vite.js under the current node |
| T4-PROD | 4 | `pnpm prod` (build → prod DB → migrate → serve): API health, built web (HTML + 134 KB bundle), web→API proxy, MCP `initialize` on 4600. A live Task was not run on prod (same code path as T2; avoids writing to a prod DB). | PASS after R18/R19 |
| R20 | 2 | An expired/revoked token parked with git's "could not read Username … terminal prompts disabled" — no mention of GitHub or the credential. Found live. | Fixed: failure parks lead with "GitHub rejected this repo's credential … Update it under Settings → Credentials, then Resume."; live: park → token fix → Resume → PR |
| R21 | 4 | **The API exited when Postgres restarted** (idle pooled client 'error' with no pool listener → uncaught). A Docker Desktop update or sleep/wake would take Atlas down. Found live. | Fixed: pool error listener; live: container restarted under the API, next write OK |
| T2-STALE | 2 | A branch `atlas/task/<key>` left on GitHub by an earlier install (DB reset renumbers Tasks). | PASS: delivered over it |
| R22 | 4 | **Terminal broken with the real CLI.** Each session's worktree is new to Claude Code, which opens on a folder-trust dialog with "No, exit" highlighted; Atlas typed the initial prompt into it 1.5 s after spawn and the CLI exited (code 1), session `paused`. Hermetic e2e uses a fake CLI. | Fixed: prompt waits for a settled screen with no trust dialog; in Atlas-made worktrees (never a folder the Owner picked) Atlas selects "Yes, I trust this folder" off the rendered screen (Owner decision). Live: session → file → Stop → PR in 26 s |
| T5 | 5 | Owner decisions: keep the `.gitignore` commit + README note; hide SSH key radio and Create from search (the formatting toolbar was already gone); C1 comments keep a deleted agent's name (migration 005, `IComment.author_name`); C2 `SdlcRole` narrowed (only `spec-writer` was unseeded — the other four are in the baseline); Atlas answers the trust dialog in its own worktrees. | Done, merged |
| T4-TERM | 4 | Terminal session with real `claude` (Haiku): start with an initial prompt → trust dialog answered → file written → Stop commits, pushes, opens the PR → session closed. | PASS |
| T4-HTTPS | 4 | `pnpm prod:https` needs Caddy, not installed here. | Not tested (optional); the missing-Caddy message now names the OS's install command |
| T2 | 2 | `e2e/live/task-to-pr-live.spec.ts` against real `claude`, `gh`, GitHub: happy path, question → reply → PR, no-change Task, Stop stays stopped, API restart → retry → PR, one agent at a time. | PASS, all 6 (two runs: 4 + 2 after the R14 fix) |
| T3-JIRA | 3 | Same spec, Jira bridge: a throwaway ATL issue (JQL `key = …`) imports as a Task, runs to a PR, Atlas comments on the issue, issue deleted. | PASS (ATL-18, deleted afterwards) |
| R17 | docs | README listed AI Readiness and Knowledge Base as "run on demand"; on demand they get a throwaway folder with no source and find nothing (live: $0.35 of Opus for nothing). They deliver through a Task's PR. | Fixed README; live: both turned a Task into a PR (#20 `skills/`, #21 `AGENTS.md`) |
| T3-MKT | 3 | Every marketplace agent installed and run once, live. AI News did real work (5 sources, digest sent). Market Research, Regulations, Jira to Epic refused on their unfilled placeholders (the designed safety net; Jira to Epic imported 0). | PASS, 6/6 + 2 Task paths |
| T3-MCP | 3 | The Owner's own `claude` (Haiku), given only this instance's MCP, created a Task via `create_item`. Agent-side MCP is covered by every Task run (outcomes, questions). | PASS |
| T4-X1 | 4 | Raw `/api/credentials`, `/api/credentials/:id`, `/api/integrations/jira`, `/api/settings` never contain the GitHub or Jira token. | PASS |
| T3-TG | 3 | Telegram: Atlas's own `testExternalNotification` against the real bot and chat. | PASS (`@Jarvis_sentinal_bot`) |
| — | 2 | Sandbox repo's `node --test test/` breaks on Node 22+ (not an Atlas bug; the agent correctly reported red tests and Atlas correctly parked). | Fixed in sandbox |

## Campaign 2 (2026-10-29/30, branch `chore/launch-confidence-2`)

Goal: find what the green suites did not test. Method: a README/guide/page-doc claims → test trace, an every-route
responsive sweep, the installer run for real from a fresh clone, and failure probes (API down, LAN reachability).

| # | Area | Finding | Status |
|---|---|---|---|
| R23 | security | **Launch blocker.** `vite --host` (dev, and `vite preview` under `pnpm start`) bound the web to 0.0.0.0. It proxies `/api` to an API with no login: from the same Wi-Fi anyone could read everything, and with a forged `Origin` header write — verified `POST` via 192.168.x.x:4300 → 201, Terminal sessions included. | Fixed 7f1c5c5: web binds 127.0.0.1 unless `ATLAS_LAN_ACCESS=true`; Caddy `default_bind`; README says what LAN mode means. Verified on a fresh clone: LAN refused, localhost OK |
| R24 | install | **Launch blocker.** `bootstrap.ps1` crashed on every machine without gh or copilot: `"Install $DisplayName?"` reads the variable `DisplayName?` (StrictMode). | Fixed 8155256 + `bootstrap-ps1.test.ts` (PowerShell AST check) |
| R25 | install | **Launch blocker.** Windows PowerShell 5.1 + `ErrorActionPreference=Stop` turns any redirected native stderr line into a terminating error: `claude mcp get atlas` for a new user, `gh auth status` always, copilot's first-run notice. Also `Ensure-ServerContainer` threw on a new (empty) `~/.copilot/mcp-config.json`. | Fixed 13f4fad: all 13 redirected native calls via `Invoke-Native`; AST test that none escapes; tests for both |
| T1 | install | `bootstrap.ps1 -NonInteractive`, elevated, fresh clone (`%TEMP%\atlas-fresh`): exit 0; second run keeps `.env`, tokens, node_modules; Copilot config gets one `atlas` entry; `pnpm doctor` passes; `pnpm dev` → `/api/health` ok, web 200, proxy ok, MCP `initialize` ok. | PASS (after R24, R25) |
| R26 | web | API unreachable (Docker stopped, API crashed/booting): RouteGuard read the failed settings fetch as "not onboarded" and redirected every page to the first-run wizard, losing the URL. | Fixed 770f049: "Atlas can't reach its API" + Retry, URL kept, auto-retry every 5 s; unit + `e2e/flows/api-unreachable.spec.ts` |
| R27 | harness | The only hermetic run → push → PR test was skipped on Windows (fake `gh` is a .cmd; `execFile('gh')` finds .exe only) and CI only builds — so it ran nowhere. | Fixed 659b506: global setup compiles a `gh.exe` forwarder with csc.exe; test also asserts the PR link, Steps and Changes in the UI |
| R28 | harness | fake-claude wrote transcripts under the old project-dir encoding, so no fake session's history was ever ingested ("Transcript unavailable"). | Fixed 19cc9bf |
| R29 | web/a11y | `/terminal/layout` had no h1. | Fixed 54f8258 (sr-only h1) |
| R30 | docs | 10 README claims that no longer matched the code (gh is required for PRs; doctor checks Docker not Postgres; DB name; PowerShell MCP command; copilot is the npm CLI; no "Free" label in Analytics; dev/start both migrate; …). | Fixed 89225ca |
| T2-RESP | ui | `e2e/responsive/all-routes.spec.ts`: 29 routes × phone 390 / iPad 834 / tablet landscape 1194 / laptop 1366, plus 6 core routes on Firefox and iPhone WebKit — heading, nav reachable, no sideways scroll, no control past the right edge. Screenshots reviewed by eye. | PASS 128/128 |
| T2-UI | ui | New journeys driven through the UI, asserted after reload: agent lifecycle (7), marketplace install, Run now + log download, Queue cancel, scratch pad autosave, search click-through, terminal history, onboarding Finish, run page Resume/Stop. | PASS |
| T2-MULTI | live | Two-repo Task with real `claude` + GitHub (`sspartorg/atlas-open-sandbox-2`): one PR, on the repo it changed. | PASS |
| T4-SEC | security | API and MCP bind 127.0.0.1; browser storage holds UI preferences only. | PASS |

**Final state:** `pnpm gate` green (shared 260, mcp 134, web 4340, api 3343 + 3 skipped; bundle in budget). `pnpm e2e` across all 7 projects: **867 passed, 0 failed** (374 skipped: Linux-only visual baselines, live specs without their flags).

**Still open**
- **Owner:** recreate the two Postgres containers so they publish on 127.0.0.1 (`db:up` reuses existing containers by design; new installs are fine). Data stays in the named volumes: `docker rm -f atlas-open-postgres atlas-open-postgres-prod && pnpm db:up && pnpm db:up:prod`.
- Copilot CLI: installed by the bootstrap run (1.0.105) but not signed in; Copilot agent runs untested (Owner decision: later).
- `prod:https` (Caddy) still not run here; the `default_bind` line is untested at runtime.
- CI runs `build` only. The hermetic e2e and unit suites run on this laptop only.
