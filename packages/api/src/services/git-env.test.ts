/**
 * git-env.test.ts
 *
 * Branch coverage for gitInvokeEnv: the single conditional branch is
 * `gitConfigPath !== null ? { GIT_CONFIG_GLOBAL: path } : {}`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { explainGitAuth, gitInvokeEnv } from './git-env.js';

/** A fresh git-env (it caches the system config) reading `systemConfig` as /etc/gitconfig. */
async function withSystemConfig(dir: string, systemConfig: string) {
    const system = join(dir, 'system-gitconfig');
    writeFileSync(system, systemConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', system);
    // The wrapper lands in the data dir; keep it inside this test's dir.
    vi.stubEnv('ATLAS_DATA_DIR', dir);
    vi.resetModules();
    return (await import('./git-env.js')).gitInvokeEnv;
}

describe('gitInvokeEnv', () => {
    it('returns GCM-silencing env vars without GIT_CONFIG_GLOBAL when path is null', () => {
        const env = gitInvokeEnv(null);
        expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
        expect(env['GCM_INTERACTIVE']).toBe('Never');
        expect(env['GCM_GUI_PROMPT']).toBe('false');
        expect(env['GCM_MODAL_PROMPT']).toBe('false');
        expect(env['GIT_CONFIG_GLOBAL']).toBeUndefined();
        // The system config is either wrapped (helper reset) or skipped, never read raw.
        expect(env['GIT_CONFIG_SYSTEM'] ?? env['GIT_CONFIG_NOSYSTEM']).toBeTruthy();
    });

    it('adds GIT_CONFIG_GLOBAL when a config path is provided', () => {
        const path = '/tmp/atlas-git-test.config';
        const env = gitInvokeEnv(path);
        expect(env['GIT_CONFIG_GLOBAL']).toBe(path);
        // GCM silencers are still set.
        expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    });

    it('keeps the system config at system scope, minus its credential helper', async () => {
        // Git for Windows' /etc/gitconfig: autocrlf=true and GCM. Skipping the whole
        // file made clean CRLF checkouts read as dirty.
        const dir = mkdtempSync(join(tmpdir(), 'atlas-git-env-'));
        try {
            const invokeEnv = await withSystemConfig(dir, '[core]\n\tautocrlf = true\n[credential]\n\thelper = manager\n');
            const global = join(dir, 'global-gitconfig');
            writeFileSync(global, '[credential]\n\thelper = store\n');
            vi.stubEnv('GIT_CONFIG_GLOBAL', global);
            const git = (...args: string[]) =>
                execFileSync('git', ['-C', dir, ...args], { env: invokeEnv(null), encoding: 'utf8' }).replace(/\r/g, '');
            git('init', '-q');
            expect(git('config', 'core.autocrlf')).toBe('true\n');
            // The empty value drops GCM; the Owner's own global helper still follows it.
            expect(git('config', '--get-all', 'credential.helper')).toBe('manager\n\nstore\n');
            // A repo's own setting still beats the system one.
            git('config', 'core.autocrlf', 'false');
            expect(git('config', 'core.autocrlf')).toBe('false\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes the wrapper again when something deletes it under a running API', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'atlas-git-env-'));
        try {
            const invokeEnv = await withSystemConfig(dir, '[core]\n\tautocrlf = true\n');
            const wrapper = invokeEnv(null)['GIT_CONFIG_SYSTEM'] as string;
            rmSync(wrapper);
            expect(invokeEnv(null)['GIT_CONFIG_SYSTEM']).toBe(wrapper);
            expect(existsSync(wrapper)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips the system config on git older than 2.32 (no GIT_CONFIG_SYSTEM there)', async () => {
        vi.doMock('node:child_process', async (orig) => ({
            ...(await orig<Record<string, unknown>>()),
            execFileSync: () => 'git version 2.25.1\n',
        }));
        try {
            vi.resetModules();
            const { gitInvokeEnv: invokeEnv } = await import('./git-env.js');
            expect(invokeEnv(null)).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1' });
            expect(invokeEnv(null)['GIT_CONFIG_SYSTEM']).toBe(process.env['GIT_CONFIG_SYSTEM']);
        } finally {
            vi.doUnmock('node:child_process');
        }
    });

    it('skips the system config when there is none', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'atlas-git-env-'));
        try {
            const invokeEnv = await withSystemConfig(dir, '');
            expect(invokeEnv(null)['GIT_CONFIG_NOSYSTEM']).toBe('1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    afterEach(() => vi.unstubAllEnvs());

    it("drops a parent Claude Code session's identity so a spawned claude is its own session", () => {
        // Atlas started from a Claude Code terminal inherits these; a child
        // claude that sees them skips writing its own transcript.
        vi.stubEnv('CLAUDECODE', '1');
        vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'parent');
        vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1');
        vi.stubEnv('CLAUDE_CONFIG_DIR', '/home/me/.claude-work');
        const env = gitInvokeEnv(null);
        expect(env['CLAUDECODE']).toBeUndefined();
        expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
        expect(env['CLAUDE_CODE_CHILD_SESSION']).toBeUndefined();
        // Owner configuration is not session identity — it stays.
        expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/me/.claude-work');
    });
});

// Found live: an expired token parks with git's "could not read Username …
// terminal prompts disabled", which names neither GitHub nor the credential.
describe('explainGitAuth', () => {
    const live = "Could not prepare the worktree: Command failed: git fetch origin main\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";

    it('leads a rejected-credential failure with what to do, and keeps git’s text', () => {
        const out = explainGitAuth(live);
        expect(out.split('\n')[0]).toMatch(/^GitHub rejected this repo's credential.*Settings → Credentials, then Resume\.$/);
        expect(out).toContain(live);
        expect(explainGitAuth('remote: Invalid username or password.\nfatal: Authentication failed')).toMatch(/^GitHub rejected/);
        expect(explainGitAuth('The requested URL returned error: 403')).toMatch(/^GitHub rejected/);
    });

    it('leaves every other failure as it was', () => {
        expect(explainGitAuth('Push failed: non-fast-forward')).toBe('Push failed: non-fast-forward');
    });
});
