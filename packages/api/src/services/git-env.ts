/**
 * Per-invocation env for every orchestrator git/gh shell-out.
 *
 * Lifted from `worktree-orchestrator.ts` so every service that shells out to git
 * shares the same shape. Previously each file rolled its own partial env block
 * (some missed `GIT_CONFIG_NOSYSTEM`, some had no env at all) which on Windows
 * leaked through to Git for Windows's bundled GCM via `/etc/gitconfig`'s
 * `credential.helper = manager` — surfacing as a modal popup right after the
 * agent's run-end push (the cleanup fetch was the loudest offender; see
 * `cleanupWorktreeAfterPush`).
 *
 * Locks down every interactive credential path so we never block on GCM:
 *   - `GIT_CONFIG_SYSTEM` points at a wrapper that includes `/etc/gitconfig`
 *     and then resets `credential.helper`. Git for Windows ships
 *     `credential.helper = manager` there — that file is the actual source of
 *     the GCM popups when our per-call temp global config is missing (e.g. the
 *     project has no credential row). The rest of the file (its `core.autocrlf`
 *     above all: without it a clean CRLF checkout reads as dirty) still applies
 *     at system scope, and the Owner's global helper still follows the reset.
 *     With no system config at all, `GIT_CONFIG_NOSYSTEM=1`.
 *   - `GIT_TERMINAL_PROMPT=0` silences tty prompts.
 *   - `GCM_INTERACTIVE` / `GCM_GUI_PROMPT` / `GCM_MODAL_PROMPT` are three
 *     flavours of GCM-Core silence flag (different versions read different
 *     ones; setting all three is cheap and complete).
 *
 * When a credential is wired, `GIT_CONFIG_GLOBAL` points at a per-call temp
 * file containing `http.extraheader = AUTHORIZATION: basic <b64>`. Build that
 * tempfile via `buildGitConfig` from `./git-credentials.ts` and pass its path.
 * Pass `null` for local-only git calls (worktree remove, branch -D, status,
 * log, rev-parse, config get/set) — they don't touch the network so they don't
 * need the credential, but the GCM silencers still matter because some local
 * git operations on Windows still probe the helper chain.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './crypto.js';

/**
 * Variables a running Claude Code session exports to its children. When Atlas
 * itself is started from a Claude Code terminal, every claude it spawns would
 * otherwise believe it is a child of that session — and skip writing its own
 * transcript, which empties the Terminal history. Named one by one: other
 * CLAUDE_CODE_* vars (USE_BEDROCK, OAUTH_TOKEN, …) are Owner config and stay.
 */
const PARENT_CLAUDE_SESSION_VARS = [
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_EXECPATH',
];

function hostEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of PARENT_CLAUDE_SESSION_VARS) delete env[key];
    return env;
}

interface SystemWrapper {
    path: string;
    body: string;
}

function writeWrapper(w: SystemWrapper): void {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.body, { mode: 0o600 });
}

/** Null: skip the system config outright (no git, git < 2.32, or no system config). */
function buildWrapper(): SystemWrapper | null {
    const git = (args: string[]) =>
        execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try {
        // GIT_CONFIG_SYSTEM arrived in git 2.32; older git would read the real
        // file, GCM helper and all.
        const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(git(['version'])) ?? []).slice(1).map(Number);
        if (major < 2 || (major === 2 && minor < 32)) return null;
        // `-z`: `file:<path>\0<key>\n<value>\0…`, the path unquoted even when
        // non-ASCII; empty when there is no system config.
        const first = git(['config', '--system', '--list', '--show-origin', '-z']).split('\0')[0] ?? '';
        const path = first.startsWith('file:') ? first.slice(5) : '';
        if (!path) return null;
        const body = `[include]\n\tpath = ${JSON.stringify(path)}\n[credential]\n\thelper =\n`;
        // Atlas's own data folder, not shared temp: git trusts this file as system
        // config. Named by content, so processes with different configs never clash.
        const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
        const w = { path: join(dataDir(), `system-${hash}.gitconfig`), body };
        writeWrapper(w);
        return w;
    } catch {
        return null; // no git, or no system config (exit 1)
    }
}

// Built once per process (main.ts warms it at boot): two sync git spawns, not per call.
let systemWrapper: SystemWrapper | null | undefined;
function systemConfig(): NodeJS.ProcessEnv {
    if (systemWrapper === undefined) systemWrapper = buildWrapper();
    if (!systemWrapper) return { GIT_CONFIG_NOSYSTEM: '1' };
    // Something deleted it under a running API: without it git would skip the
    // system config silently and autocrlf would stop applying.
    try {
        if (!existsSync(systemWrapper.path)) writeWrapper(systemWrapper);
    } catch {
        return { GIT_CONFIG_NOSYSTEM: '1' };
    }
    return { GIT_CONFIG_SYSTEM: systemWrapper.path };
}

export function gitInvokeEnv(
    gitConfigPath: string | null,
    ghToken?: string | null,
): NodeJS.ProcessEnv {
    return {
        ...hostEnv(),
        ...systemConfig(),
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GCM_GUI_PROMPT: 'false',
        GCM_MODAL_PROMPT: 'false',
        ...(gitConfigPath ? { GIT_CONFIG_GLOBAL: gitConfigPath } : {}),
        // `gh` reads its auth from GH_TOKEN / GITHUB_TOKEN env vars before
        // consulting `~/.config/gh/hosts.yml`. Without these, `gh pr create`
        // in a spawned shell would fall back to the developer's own
        // `gh auth login` and the resulting PR would be attributed to
        // them even though `git commit`/`git push` (which read
        // `GIT_CONFIG_GLOBAL`) run as the bot. Passing the same token
        // that lives in `http.extraheader` keeps both tools in sync.
        ...(ghToken ? { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } : {}),
    };
}

/**
 * GitHub turning a credential away. With prompts disabled git rarely says so:
 * an expired token surfaces as "could not read Username … terminal prompts
 * disabled", which reads like a setup bug rather than a token to replace.
 */
export const GIT_AUTH_REJECTED = /could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|HTTP 40[13]|returned error: 40[13]/i;

/** What to do first when GitHub rejected the credential (kept ahead of git's text, which may be cut), then the message. */
export function explainGitAuth(message: string): string {
    if (!GIT_AUTH_REJECTED.test(message)) return message;
    return `GitHub rejected this repo's credential: the token may be expired, revoked, or missing access to the repo. Update it under Settings → Credentials, then Resume.\n${message}`;
}
