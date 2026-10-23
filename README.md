# Atlas Open

> Assign a Task to an AI coding agent and get a pull request back.

Atlas Open is the free, open-source (AGPL-3.0-only) edition of Atlas by
Sspart Enterprise Private Limited. It is a single-owner workbench: a UI, an
API and an MCP server that tie together your projects, the agents that work
on them, and the conversation that keeps you and the agents aligned.

**How a Task gets done.** Create a Task, assign it one agent, and the Task
queues. When its turn comes, that one agent runs it end to end in its own git
worktree and branch. When the agent finishes, Atlas commits anything it left
uncommitted, pushes, and opens the pull request (one per repo the Task
touched). If the agent asks a question, the run parks and waits for you;
your reply on the Task resumes it. A crashed run gets one automatic retry.
Up to three Tasks run at once, and only one Task per repo at a time.

## What's in Atlas Open

- **Projects** with one or more repos, **Tasks**, sub-tasks, issues and comments
- **One agent per Task**, run end to end with commit, push and PR handled by Atlas; a run page at `/runs/:runId` with steps, changes, Stop and Resume
- **Agents** with memory, checklists and agent tests
- **Marketplace** of installable agents: Solo Engineer (`agent-solo`), plus AI News, AI Readiness, Jira to Epic, Knowledge Base, Market Research and Regulations, which run on demand
- **Jira bridge**: each source is a JQL query, an agent and the repos to use; imported Tasks are assigned to that agent
- **Guardrails** and guardrail scripts
- **Reminders**, in-app and push **notifications**, external notifications (Telegram, Microsoft Teams)
- **Analytics** (delivery), **terminal / CLI sessions**, scratch pad, search
- **Credentials and secrets**, and an **MCP server** so your AI CLI can drive Atlas

## Atlas Open vs Atlas

Atlas (the commercial edition) adds workflows on top of everything above.

| | Atlas Open (free) | Atlas (commercial) |
|---|---|---|
| Projects, multi-repo, Tasks, sub-tasks, issues, comments | Yes | Yes |
| Agents, memory, checklists, agent tests | Yes | Yes |
| Marketplace agents | Solo Engineer + 6 on-demand agents | Plus the 18-agent SDLC pipeline catalog (architect, coder, reviewers, fixers, QA...) |
| How a Task runs | One agent does the whole Task | Workflows: a chain of specialised agents, each with a small scoped context window, with pass/fail loops |
| Jira bridge, guardrails, reminders, notifications, terminal, MCP | Yes | Yes |
| Analytics | Delivery | Plus workflow analytics |
| Workflow graph builder, script steps (custom command executors) | No | Yes |
| Sub-task fan-out, owner gates | No | Yes |
| Scheduled workflows and agents | No | Yes |
| Workflow templates, marketplace publishing, workflow evals | No | Yes |
| CI follow-through auto-fix | No | Yes |
| Team config sync | No | Yes |

### Why upgrade

Atlas Open is easy: one agent does everything. The trade-off is that the
agent carries the whole Task in one context window, so it uses more tokens.
Atlas's workflows split the work into steps whose context stays small and
relevant, which costs less per Task and lets you add your own checks between
steps. If that matters to you, contact sspart.org@gmail.com.

---

This README gets a teammate from a fresh clone to a running app in 10–15
minutes on Windows, macOS, or Linux — one command on each (see below).

---

## One-command install (Windows)

Skip the manual prerequisites section if you're on Windows 11 and want a
single command to set everything up — tools, env files, MCP token, database,
MCP client registration, and verification:

```powershell
# Open an ELEVATED PowerShell at the repo root, then:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
```

`scripts/bootstrap.ps1` installs (or upgrades) Git, Node.js LTS, pnpm, Docker
Desktop, GitHub CLI, GitHub Copilot CLI extension, and Claude Code CLI via
`winget`; enables WSL2 + Windows long paths; copies `.env` / `.env.prod` from
their examples; generates a random `ATLAS_MCP_TOKEN`; runs `pnpm install`;
brings Postgres up and applies migrations; registers `atlas` as an MCP server
with Claude Code CLI and GitHub Copilot CLI; and finishes by running
`pnpm doctor`. It is idempotent — re-running on a configured machine walks
every prompt with **Keep** as the default, so a single Enter trip-through is
safe.

Flags:

- `-SkipOptionalCLIs` — skip Claude / gh / Copilot installs (CI scenario).
- `-NonInteractive` — take the default for every prompt (CI / unattended).

Both `.env` and `.env.prod` are always created — the dev and prod local stacks
are designed to coexist, so leaving one out breaks the other.

After it finishes, run `pnpm dev` and open <http://localhost:4300>.

If the script just enabled WSL2 for you, reboot Windows once before `pnpm dev`
so Docker Desktop's engine can come up cleanly. For real AI agent runs, also
sign in to the CLIs the script can't drive interactively:

```powershell
claude login         # Anthropic sign-in
gh auth login        # GitHub sign-in (also unlocks `gh copilot`)
```

---

## One-command install (macOS / Linux)

The same setup as the Windows script, for macOS (Homebrew), Debian/Ubuntu
(apt), Fedora/RHEL (dnf) and Arch (pacman):

```bash
# From the repo root, as your normal user (it calls sudo where it needs to):
bash scripts/bootstrap.sh
```

`scripts/bootstrap.sh` installs whatever is missing: Git, Node.js ≥ 20
(Homebrew on macOS, NodeSource on apt/dnf), pnpm ≥ 9 (via corepack), Docker
(Docker Desktop on macOS; Docker Engine + Compose plugin on Linux, adding you
to the `docker` group), and optionally GitHub CLI, the GitHub Copilot CLI
extension and Claude Code CLI (`npm install -g @anthropic-ai/claude-code`). On
macOS without Homebrew it offers to install Homebrew first. Then it copies
`.env` / `.env.prod` from their examples, generates a random
`ATLAS_MCP_TOKEN`, runs `pnpm install`, brings Postgres up and migrates it,
registers `atlas` with Claude Code CLI (the same `claude mcp add-json` call as
the Windows script) and Copilot CLI, and finishes with `pnpm doctor`.

It is idempotent: every step checks first and prints `keep:` when there is
nothing to do, so re-running on a configured machine changes nothing. If a
step fails, the script names it — fix the cause and re-run; finished steps are
skipped. Other distros get a list of the manual steps instead.

Flags:

- `--skip-optional-clis` — skip gh / Copilot / Claude installs.
- `--non-interactive` — take the default for every prompt (install what is
  missing, keep what exists).
- `--dry-run` — print every command it would run and change nothing.

If it added you to the `docker` group, log out and back in (or run
`newgrp docker`) before `pnpm dev`. Then sign in to `claude` / `gh` as above.

---

## Prerequisites

Install these once, then never again:

- **Node** 20 or newer
- **pnpm** 9 or newer (`npm i -g pnpm` if you don't have it)
- **Docker** — Docker Desktop on Windows/macOS, Docker Engine + Compose v2 on Linux
- **Postgres 16** — runs in Docker via `pnpm db:up`. SQLite is no longer supported.
- **Git** on your `PATH`

Optional (only matters once you start spawning real agent runs):

- **Claude Code CLI** (`claude`) — for live agent runs with `ATLAS_AI_ENABLED=true`
- **GitHub CLI** (`gh`) — only needed if you use GitHub PAT credentials and want the CLI's helpers
- **Ollama** (`ollama`) — for the free, local `ollama` CLI option (see below)

---

## Setup check (optional)

Once Node and pnpm are installed, run:

```bash
pnpm install
pnpm doctor
```

`pnpm doctor` verifies that node ≥ 20, pnpm ≥ 9, docker, and git are on
your `PATH`, and reports the versions it found. Optional checks for
`claude`, `copilot`, `ollama`, and `gh` will show `[skip]` if they aren't
installed. Use this if you're not sure your machine has everything before
running `pnpm dev`.

---

## Ollama (free, local models)

Atlas exposes three CLI choices per agent and per terminal session: `claude`,
`copilot`, and `ollama`. The third one runs your agents on local (or Ollama
Cloud) models at **no cost**.

`ollama` is not a separate tool. Ollama serves an
[Anthropic-compatible API](https://docs.ollama.com/integrations/claude-code),
so Atlas spawns the **same `claude` binary** and repoints it at your Ollama
server. Everything else is unchanged: same flags, same streamed transcript,
same Pause/Resume, same worktree flow. Only the model list and the price differ.

Setup:

1. Install [Ollama](https://ollama.com/download) and make sure `ollama` is on
   your `PATH`. Keep the Claude Code CLI installed too — Ollama drives it.
2. Pull a model. For anything beyond trivial edits, give local models a 64k+
   context window; small contexts are the usual cause of an agent "forgetting"
   the task mid-run.
   ```bash
   ollama pull qwen3.5
   ```
3. If your Ollama server isn't on the default `http://localhost:11434`, set
   `ATLAS_OLLAMA_BASE_URL` in `.env` (or edit it under **Settings → Env**).
4. In Atlas, go to **Settings → Model Registry → Ollama** and make sure the
   models you actually pulled are listed. Three are seeded as a starting point;
   add or remove rows so the list matches `ollama list`.
5. Pick **Ollama** as the CLI when creating an agent, or in the Terminal's
   Start Session dialog.

Ollama runs record `$0` and are labelled Free in Analytics, so the per-CLI
breakdown shows exactly what you saved.

---

## Quickstart

```bash
git clone https://github.com/sspartorg/atlas-open.git
cd atlas-open
cp .env.example .env
pnpm install
pnpm doctor    # verifies Node, pnpm, Docker, and Postgres connectivity — run this first if anything later fails
pnpm dev
```

The web UI opens at `http://localhost:4300`. The API runs at `http://localhost:4301`.
On first run you'll see the onboarding wizard — enter a display name and pick a
local folder to use as your workspace (any path you want).

Atlas uses dedicated non-default ports across every tier so dev, prod, and E2E
can coexist with each other and with any other app on the machine:

| Tier | Web | API | MCP | Postgres (host) | Postgres DB |
|---|---|---|---|---|---|
| Dev  | 4300 | 4301 | 4600 | 5600 | `atlas_open` |
| Prod | 5300 | 5301 | 4600 | 5610 | `atlas_open_prod` |
| E2E  | 7010 | 7001 | —    | 5600 (dev container, separate DB) | `atlas_open_e2e` |

These ranges are chosen so Atlas Open runs side by side with the commercial
Atlas edition (4000/4001, MCP 4500, Postgres 5500): separate ports, a separate
`atlas-open-postgres` container and volume, and a separate data folder
(`~/.config/AtlasOpen`, `%APPDATA%\AtlasOpen` on Windows).

---

## Dev vs prod local stacks

Atlas ships two parallel local stacks so you can run a stable instance for
your day-to-day work AND hack on the code without one breaking the other.
They live in the same repo, share `node_modules`, and never collide:

| Surface | Dev (`pnpm dev`) | Prod (`pnpm prod`) |
|---|---|---|
| Web port | `4300` | `5300` |
| API port | `4301` | `5301` |
| Postgres host port | `5600` | `5610` |
| Postgres container | `atlas-open-postgres` | `atlas-open-postgres-prod` |
| Postgres data volume | `atlas-open-pg` | `atlas-open-pg-prod` |
| Postgres database | `atlas` | `atlas_open_prod` |
| Env file | `.env` | `.env.prod` |
| HMR / watch | ✅ vite HMR + tsx watch | ❌ vite preview + plain tsx |

`pnpm prod` runs `pnpm build` first, then serves the static build via `vite
preview` and starts the API in non-watch mode. Editing `.ts` / `.tsx` files
does NOT affect the running prod instance — to pick up new code, re-run
`pnpm prod`. Meanwhile `pnpm dev` in another terminal keeps its HMR /
auto-restart behaviour.

The two stacks are switched by a single env var, `ATLAS_ENV`. When unset
it defaults to dev. The root `pnpm prod` script wraps every step with
`cross-env ATLAS_ENV=prod`, so the API's `load-env.ts` and web's
`vite.config.ts` both read from `.env.prod`. To set up prod for the first
time:

```bash
cp .env.prod.example .env.prod   # then edit creds / tokens as needed
pnpm prod                        # first boot starts atlas-open-postgres-prod
                                 # and runs migrations against atlas_open_prod
```

### Faster prod: HTTPS + HTTP/2 (`pnpm prod:https`)

`vite preview` speaks HTTP/1.1, so the browser fetches six files at a time
while a cold page makes 30–65 requests. `pnpm prod:https` runs the same prod
chain but serves the UI through [Caddy](https://caddyserver.com) at
**https://localhost:5643** with HTTP/2 and HTTP/3, the build's Brotli files,
immutable caching for `/assets`, and `/api` (SSE + WebSockets) proxied to
the API. Measured on slow 4G it loads pages 5–25% sooner (ADR 0031).

```bash
brew install caddy     # once (Linux: your package manager; Windows: winget install CaddyServer.Caddy)
caddy trust            # once: trusts Caddy's local CA (asks for your password)
pnpm prod:https        # https://localhost:5643
```

It sets `ATLAS_HTTPS_PORT=5643`, which makes the web serve via Caddy
(`packages/web/Caddyfile`, started by `scripts/serve.mjs`) and makes the API
trust `https://localhost:5643` as a browser origin. Plain `pnpm prod` is
unchanged. LAN access over HTTPS isn't covered — LAN devices keep using
`http://<ip>:5300`.

Useful prod-side scripts (all driven by `cross-env ATLAS_ENV=prod`):

```
pnpm prod                  # full chain: build + db up + migrate + start
pnpm db:up:prod            # start the prod Postgres container only
pnpm db:down:prod          # stop the prod container (keep data)
pnpm db:down:prod:purge    # stop + WIPE the prod volume (rare, explicit)
pnpm db:migrate:prod       # apply pending migrations to prod
pnpm db:status:prod        # show prod migration state
```

By design there is no `pnpm db:reset:prod` — wiping the prod DB shouldn't
be a one-liner.

---

## What `pnpm dev` actually does

`pnpm dev` chains four steps in order:

1. **`pnpm db:up`** — brings up the `atlas-open-postgres` container via
   `docker compose up -d postgres`. The compose file at the repo root pins
   pgvector/pgvector:pg16, host port 5600 → container port 5432, with
   `atlas`/`atlas`/`atlas` defaults (matching `DATABASE_URL` in
   `.env.example`).
2. **`pnpm db:wait`** — polls until Postgres accepts a connection (≤60 s).
3. **`pnpm db:migrate`** — applies Knex migrations from
   `packages/api/src/db/migrations/`.
4. **`pnpm --parallel -r dev`** — starts the API (Fastify on `:4301`) and
   the web UI (Vite on `:4300`) in parallel.

All four steps are pure Node — no PowerShell, no shell-specific syntax. The
same `pnpm dev` works identically on Windows, macOS, and Linux.

---

## First-run onboarding

When `settings.onboarding_complete = 0` in the DB, the app redirects every
route to `/onboarding`. The wizard has two steps:

1. **Display name + accent color.** Used in the topbar and on your own avatar.
2. **Workspace folder.** A local directory the app will treat as the parent
   for every cloned project. Pick anything you have write access to —
   examples per OS:
   - Windows: `C:\Users\You\Projects`
   - macOS: `/Users/you/Projects`
   - Linux: `/home/you/projects`

After save, the dashboard becomes the home page. Subsequent boots skip the
wizard.

---

## Multi-device access (LAN)

By default, Atlas only trusts browser requests from `localhost:4300` and
`127.0.0.1:4300` (dev) — `localhost:5300` / `127.0.0.1:5300` on prod. Open the
UI from a second device on the same Wi-Fi and you can READ data (the page
renders, SSE arrives) but every WRITE silently fails — the API blocks the
cross-origin POST/PATCH.

To enable LAN access, set this in `.env`:

```bash
ATLAS_LAN_ACCESS=true
```

Then restart the API. On boot you'll see something like:

```
[security] ATLAS_LAN_ACCESS=true — trusting LAN origins for CORS + MCP-token gate: http://192.168.1.50:4300, http://10.0.0.5:4300
```

Both ends of the trust contract are updated: the CORS allowlist accepts the
LAN origin, and the MCP-token gate treats it as a trusted browser origin (so
the React app doesn't need to start sending tokens).

Leave `ATLAS_LAN_ACCESS` unset (or `false`) to keep Atlas locked to
localhost — the safer default if you don't want your dev API reachable from
any other device on the network.

---

## Connecting Atlas to your AI CLI (MCP)

The Atlas API hosts an MCP listener in-process at
`http://127.0.0.1:4600/mcp`. Your AI clients (Claude Code, Claude Desktop,
GitHub Copilot CLI) connect to that single URL. No repo paths, no tokens, no
copy-paste between dev and prod, no `<REPO>` placeholders to update when you
move the clone.

**One URL, two stacks.** Whichever local stack (`pnpm dev` or `pnpm prod`)
starts first owns port 4600 and serves MCP. The other instance catches
`EADDRINUSE`, logs `[mcp] port 4600 in use — running API-only`, and serves
its own `/api/*` traffic without MCP. To hand MCP over, stop the owning
instance and start the other — the client config never changes.

The listener binds loopback only. `ATLAS_LAN_ACCESS` does not expose MCP to
the LAN under any setting. The `ATLAS_MCP_TOKEN` from `.env` / `.env.prod`
is still required, but it's used internally by the MCP shim when it calls
back into the API — it's never something the client sends. Clients connect
anonymously to loopback.

**Prerequisite:** the API must be running (`pnpm dev` or `pnpm prod`). If you
hit `ATLAS_HOST_MCP=false` in your env, the listener is disabled on that
stack — useful for headless / CI runs, but then no client can connect.

### Claude Code CLI (`claude mcp`)

From any directory:

```powershell
claude mcp add-json atlas --scope user '{\"url\":\"http://127.0.0.1:4600/mcp\"}'
```

Verify with `claude mcp list` — you want `atlas ✓ Connected`. The `--scope
user` flag makes the registration follow you across projects.

To update or remove, `claude mcp remove atlas -s user` then re-run `add-json`.

### Claude Desktop

Edit your Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Merge this entry into the top-level `mcpServers` object (create the object
if the file is empty), then fully restart the desktop app:

```json
{
  "mcpServers": {
    "atlas": {
      "url": "http://127.0.0.1:4600/mcp"
    }
  }
}
```

### GitHub Copilot CLI (`copilot mcp`)

Copilot CLI keeps its MCP registrations in `~/.copilot/mcp-config.json`
(override the parent directory by setting `$COPILOT_HOME`). Merge this entry
into the top-level `mcpServers` object, then restart any open `copilot`
sessions:

```json
{
  "mcpServers": {
    "atlas": {
      "type": "http",
      "url": "http://127.0.0.1:4600/mcp",
      "tools": ["*"]
    }
  }
}
```

`tools: ["*"]` exposes every tool the Atlas MCP server registers. Replace
the wildcard with an explicit list if you want to scope down (e.g. block
`crud_agent` on a particular workstation).

Verify with `copilot mcp list` — you want `atlas ✓ Connected`.

If your Copilot CLI version doesn't recognise `"type": "http"`, drop in the
`mcp-remote` stdio shim that bridges to the HTTP endpoint — same single URL,
same zero-credential client config:

```json
{
  "mcpServers": {
    "atlas": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:4600/mcp"],
      "tools": ["*"]
    }
  }
}
```

### Legacy stdio transport

The MCP package still ships a stdio entry point at `packages/mcp/src/index.ts`
for CI and sandboxed environments where the API process can't host the
listener. See [`.agents/mcp.md`](.agents/mcp.md) for that path — it requires
a built `dist/`, a `ATLAS_API_BASE` env var, and manual reconfiguration when
you switch between dev (4301) and prod (5301). The HTTP host above is the
supported flow for every other case.

---

## Setting up external notifications

Atlas delivers outbound alerts (reminder fires, agent completions,
quiet-hours-respecting notifications) through a provider-agnostic transport.
It supports **Telegram** and **Microsoft Teams**. All setup happens under
**Settings → Notifications** in the UI — no file edits required.

### Telegram (fast, personal)

1. Chat with [@BotFather](https://t.me/BotFather) on Telegram and send
   `/newbot`. Follow the prompts to name your bot; save the returned **bot
   token**.
2. Message your new bot from the chat you want notifications to land in.
3. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a
   browser and copy the `"chat":{"id":...}` value — that's your **chat ID**.
4. In Atlas: **Settings → Notifications → Provider: Telegram** → paste
   token + chat ID → **Send Test Message**.

### Microsoft Teams (via Power Automate)

Atlas's Teams transport posts a v1.4 Adaptive Card as the entire HTTP body
(`packages/api/src/services/transports/teams.ts#buildAdaptiveCard`). Your
Power Automate flow needs to deserialise that body and feed it to
`PostCardToConversation`. Minimal working recipe on
[make.powerautomate.com](https://make.powerautomate.com) → **Create →
Instant cloud flow**:

1. **Trigger:** *When an HTTP request is received* — leave the request body
   schema blank (Power Automate accepts any JSON).
2. **Action 1:** *Initialize variable* — Name `Body`, Type `String`, Value
   `@{string(triggerBody())}`.
   > ⚠ **Critical:** stringify the WHOLE incoming object, NOT a sub-field.
   > Older guides mapping `triggerBody()?['text']` break under Atlas's
   > Adaptive Card payload.
3. **Action 2:** *Post card in a chat or channel* (`PostCardToConversation`)
   — Post as `Flow bot`, Post in `Group chat` or `Channel`, Recipient = the
   chat/channel ID, Adaptive Card = `@{variables('Body')}`.
4. Save the flow. Copy the HTTP POST URL Power Automate generates.
5. In Atlas: **Settings → Notifications → Provider: Microsoft Teams** →
   paste the webhook URL → **Send Test Message**.

The card Atlas sends is:

```json
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.4",
  "body": [
    { "type": "TextBlock", "text": "Your notification text here", "wrap": true }
  ]
}
```

`wrap: true` is required so multi-line messages render with line breaks
preserved. Paste into [adaptivecards.io/designer](https://adaptivecards.io/designer/)
to preview / tweak.

### Fine-tuning

- **Per-event opt-ins** — same Notifications tab. Toggle each event class
  (agent completion, reminder fire, run error, item transition) independently.
- **Quiet hours** — deliveries queue during the configured window and
  release at the next allowed slot. Applies to both external transport and
  in-app.
- **Tokens encrypted at rest** — bot token and webhook URL are encrypted via
  `settingsService.updateExternalNotificationToken` before storage.

### Troubleshooting

- **Flow run fails with `AdaptiveSerializationException: Property 'type'
  must be 'AdaptiveCard'`** — the `Body` variable is mapped to a sub-field
  instead of `string(triggerBody())`. Fix step 2 of the recipe.
- **Test message reports delivered but nothing arrives in Telegram** — chat
  ID is wrong. Re-send a message from the target chat, re-hit `/getUpdates`,
  and confirm the ID.
- **Test message returns 4xx / connection pill is red** — reveal the token
  / webhook URL and confirm no whitespace was pasted (leading space is the
  most common cause).

The [user guide](docs/guide/README.md) covers the same ground with
screenshots.

---

## Repo layout

```
packages/shared/   — types, status machine, Zod schemas (zero runtime deps)
packages/api/      — Fastify API + Kysely + Postgres
packages/web/      — React UI + MUI + TanStack Query
packages/mcp/      — Model Context Protocol server
.agents/           — terse functional docs read by AI coding agents
```

Contribution conventions for this repo (hard rules, package patterns, the
`.agents/` self-update protocol): see [`AGENTS.md`](./AGENTS.md).

Per-package patterns: `packages/shared/AGENTS.md`, `packages/api/AGENTS.md`,
`packages/web/AGENTS.md`, `packages/mcp/AGENTS.md`.

---

## Updating to a new version

When new commits land on `main`:

1. `git pull`
2. `pnpm install` — in case dependencies changed.
3. `pnpm db:migrate` — in case the schema changed. **Required if you use `pnpm start`**; auto-runs at boot if you only use `pnpm dev`.
4. Restart the API (`pnpm dev` or `pnpm start`).

If the migration step fails, the API refuses to start: it prints `[boot] migration failed, refusing to start:` with the underlying error and exits with code 1. Read the error and either fix your `.env` / Postgres state, or use the in-app **Report a bug** link (sidenav footer + `Settings → Help & About`). The link opens `ATLAS_FEEDBACK_URL`; point it at the issue tracker you want (for example `https://github.com/sspartorg/atlas-open/issues`), a `mailto:` URL, or leave it blank to hide the link.

---

## Troubleshooting

**`docker compose up failed`** — confirm Docker is running. On Windows/macOS
that's Docker Desktop in the system tray. On Linux it's `systemctl status
docker`.

**`postgres did not become ready within 60s`** — usually means the container
crashed mid-boot. `docker logs atlas-open-postgres` shows the cause; the most
common is host port 5600 already in use. Stop whatever else is bound there
(`netstat -ano | findstr :5600` on Windows, `lsof -iTCP:5600 -sTCP:LISTEN` on
Mac/Linux) or change the host port in `docker-compose.yml`.

**Can't write from a second device on the LAN** — set
`ATLAS_LAN_ACCESS=true` in `.env` and restart the API. See "Multi-device
access" above.

**`PowerShell` no longer used.** Every API script (db, clone, auto-fetch)
runs in Node and spawns `git` / `docker` directly. Atlas's runtime has no
PowerShell dependency on any OS.

**Credentials decrypt to garbage after deleting `workspace.key` on macOS.**
macOS doesn't expose a stable machine ID Atlas can re-derive
`workspace.key` from, so the file is generated with random bytes on first
boot. If you delete `~/.config/AtlasOpen/workspace.key` (or move to a new
mac), the new key won't decrypt your old stored credentials — re-enter
Credentials in the UI. On Windows and Linux the key is re-derived from
`MachineGuid` / `/etc/machine-id`, so it survives file deletion on the
same machine.

---

## License

Atlas Open is free software, licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

Copyright © 2026 Sspart Enterprise Private Limited. See [`NOTICE`](NOTICE).

You may use, modify and redistribute Atlas Open under the AGPL. If you run a
modified version as a network service, the AGPL requires you to offer its
users the complete corresponding source code.

Atlas, the commercial edition with workflows, is available from Sspart
Enterprise Private Limited under a separate commercial license. Contact
sspart.org@gmail.com.
