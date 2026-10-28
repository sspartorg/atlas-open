import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { agentRunEnv, allowedToolsFor, claudeIsolationArgs, cliArgs, copilotDenyToolArgs } from './agent-runner.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Agent runs spawn the Owner's own `claude` binary. Without isolation they
// inherit ~/.claude hooks, plugins, user CLAUDE.md and every user-scope MCP
// server; with it they load only project/local settings (so the worktree's
// `.claude/commands/atlas-*` still resolve) and the Atlas MCP server.
describe('claudeIsolationArgs', () => {
    it('restricts settings to project+local and MCP to the Atlas HTTP server only', () => {
        const args = claudeIsolationArgs(true);
        expect(args.slice(0, 3)).toEqual(['--setting-sources', 'project,local', '--strict-mcp-config']);
        expect(args[3]).toBe('--mcp-config');
        expect(JSON.parse(args[4] ?? '')).toEqual({
            mcpServers: { atlas: { type: 'http', url: 'http://127.0.0.1:4600/mcp' } },
        });
        expect(args).toHaveLength(5);
    });

    it('leaves freedom-mode scouts on the Owner config so their Playwright / claude.ai connectors still load', () => {
        expect(claudeIsolationArgs(false)).toEqual([]);
    });
});

// The allowlist has to match what the run can actually reach. An item-attached
// run is strict-MCP-isolated, so naming the Atlassian prefix only told the agent
// it could fetch a Jira issue live — and a bridge-imported Task hands it a key
// and a browse URL in the description. The snapshot IS the source of truth.
describe('allowedToolsFor', () => {
    it('withholds the Atlassian prefix from item-attached runs', () => {
        const tools = allowedToolsFor(true).split(',');
        expect(tools).not.toContain('mcp__claude_ai_Atlassian');
        expect(tools).toContain('mcp__atlas');
        expect(tools).toContain('mcp__playwright');
        expect(tools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']));
    });

    it('keeps it for freedom scouts, whose whole job is reading Jira', () => {
        expect(allowedToolsFor(false).split(',')).toContain('mcp__claude_ai_Atlassian');
    });
});

// Copilot has no strict-MCP-config flag and Atlas spawns it with
// --allow-all-tools, so an item-attached Copilot run used to reach every MCP
// server the Owner had registered — further than an item-attached Claude run,
// which strict-config confines to the Atlas server. Deny rules beat
// --allow-all-tools, so denying each server by name is the equivalent.
describe('copilotDenyToolArgs', () => {
    const saved = process.env['COPILOT_HOME'];
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'atlas-copilot-home-'));
        process.env['COPILOT_HOME'] = home;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env['COPILOT_HOME'];
        else process.env['COPILOT_HOME'] = saved;
        rmSync(home, { recursive: true, force: true });
    });

    function writeConfig(body: string) {
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'mcp-config.json'), body, 'utf8');
    }

    /** ['--deny-tool','a','--deny-tool','b'] -> ['a','b'] */
    function denied(args: string[]): string[] {
        expect(args.length % 2).toBe(0);
        return args.filter((_, i) => i % 2 === 1);
    }

    it('leaves freedom scouts alone — agent-jira-to-epic exists to read Jira', () => {
        writeConfig(JSON.stringify({ mcpServers: { atlassian: {}, github: {} } }));
        expect(copilotDenyToolArgs(false)).toEqual([]);
    });

    it('denies every server the Owner registered, plus the built-in', () => {
        writeConfig(JSON.stringify({ mcpServers: { atlassian: {}, playwright: {} } }));
        const args = copilotDenyToolArgs(true);
        expect(args.filter((a) => a === '--deny-tool')).toHaveLength(3);
        expect(denied(args).sort()).toEqual(['atlassian', 'github-mcp-server', 'playwright']);
    });

    it("keeps Atlas's own server reachable", () => {
        writeConfig(JSON.stringify({ mcpServers: { atlas: {}, atlassian: {} } }));
        expect(denied(copilotDenyToolArgs(true))).not.toContain('atlas');
        expect(denied(copilotDenyToolArgs(true))).toContain('atlassian');
    });

    // A deny naming a server that isn't configured is inert, so the built-in
    // is still worth passing on a machine where Copilot has never run.
    it('still denies the built-in when there is no config at all', () => {
        expect(denied(copilotDenyToolArgs(true))).toEqual(['github-mcp-server']);
    });

    it('does not throw on a malformed or empty config', () => {
        writeConfig('{ not json');
        expect(denied(copilotDenyToolArgs(true))).toEqual(['github-mcp-server']);
        writeConfig(JSON.stringify({}));
        expect(denied(copilotDenyToolArgs(true))).toEqual(['github-mcp-server']);
    });

    it('reads COPILOT_HOME rather than assuming ~/.copilot', () => {
        // Nothing written to `home` yet, so a stray read of the real ~/.copilot
        // would be the only way another server could appear here.
        expect(denied(copilotDenyToolArgs(true))).toEqual(['github-mcp-server']);
        writeConfig(JSON.stringify({ mcpServers: { relocated: {} } }));
        expect(denied(copilotDenyToolArgs(true)).sort()).toEqual([
            'github-mcp-server',
            'relocated',
        ]);
    });
});

describe('agentRunEnv', () => {
    const saved = { API_PORT: process.env['API_PORT'], PORT: process.env['PORT'] };
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('exposes ATLAS_API_URL on the API port so .atlas/scripts validators can query the API', () => {
        process.env['API_PORT'] = '4101';
        expect(agentRunEnv('claude', 'claude-opus-4-7', null)['ATLAS_API_URL']).toBe('http://127.0.0.1:4101');
    });

    it('falls back to PORT, then 4301', () => {
        delete process.env['API_PORT'];
        process.env['PORT'] = '5001';
        expect(agentRunEnv('copilot', 'gpt-5.4', null)['ATLAS_API_URL']).toBe('http://127.0.0.1:5001');
        delete process.env['PORT'];
        expect(agentRunEnv('copilot', 'gpt-5.4', null)['ATLAS_API_URL']).toBe('http://127.0.0.1:4301');
    });

    it('keeps the git identity config and layers the ollama overlay last', () => {
        const env = agentRunEnv('ollama', 'qwen3.5', '/tmp/gitconfig');
        expect(env['GIT_CONFIG_GLOBAL']).toBe('/tmp/gitconfig');
        expect(env['ANTHROPIC_API_KEY']).toBe('');
        expect(env['ATLAS_API_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    // ADR 0015 — Atlas pushes and opens the PR; the agent holds no token, not
    // even one exported in the Owner's shell.
    it('passes no GitHub token, even one from the host env', () => {
        const prev = { GH_TOKEN: process.env['GH_TOKEN'], GITHUB_TOKEN: process.env['GITHUB_TOKEN'] };
        process.env['GH_TOKEN'] = 'host-gh';
        process.env['GITHUB_TOKEN'] = 'host-github';
        try {
            for (const cli of ['claude', 'copilot', 'ollama'] as const) {
                const env = agentRunEnv(cli, 'm', '/tmp/gitconfig');
                expect(env).not.toHaveProperty('GH_TOKEN');
                expect(env).not.toHaveProperty('GITHUB_TOKEN');
            }
        } finally {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });

    // The override must beat a credential helper / extraheader in any config
    // file git reads, so check it against real git, not the env shape.
    it('resets credential.helper and http.extraheader over a config that sets them', () => {
        const dir = mkdtempSync(join(tmpdir(), 'atlas-agent-env-'));
        try {
            const cfg = join(dir, 'config');
            writeFileSync(cfg, '[credential]\n\thelper = store\n[http]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n');
            const env = agentRunEnv('claude', 'm', cfg);
            const get = (key: string) =>
                execFileSync('git', ['config', '--get-all', key], { env, cwd: dir, encoding: 'utf8' }).replace(/\n$/, '').split('\n');
            // `--get-all` lists every value (this machine's system ones first, if
            // any); the reset leaves the empty one last, after the config's own.
            expect(get('credential.helper').slice(-2)).toEqual(['store', '']);
            expect(get('http.extraheader').slice(-2)).toEqual(['AUTHORIZATION: basic c2VjcmV0', '']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ADR 0015 — agents only edit files. The prompt says so; these flags are the
// hard block. Ollama runs the claude binary and must get the same list.
describe('cliArgs — git commit / push / gh are blocked', () => {
    const base = { model: 'm', effort: 'medium', runId: 'run-1', slug: 'coder', cwd: '/tmp/wt' };

    /** Every value after `--disallowedTools` (variadic, last flag on the argv). */
    function disallowed(args: string[]): string[] {
        return args.slice(args.indexOf('--disallowedTools') + 1);
    }

    for (const cli of ['claude', 'ollama'] as const) {
        for (const itemAttached of [true, false]) {
            it(`${cli} (itemAttached=${itemAttached}) disallows git commit, git push and gh`, () => {
                const args = cliArgs({ ...base, cli, itemAttached });
                expect(args[0]).toBe('--print');
                expect(disallowed(args)).toEqual(
                    expect.arrayContaining(['Task', 'WebFetch', 'WebSearch', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)']),
                );
            });
        }
    }

    for (const itemAttached of [true, false]) {
        it(`copilot (itemAttached=${itemAttached}) denies shell(git commit), shell(git push) and shell(gh)`, () => {
            const args = cliArgs({ ...base, cli: 'copilot', itemAttached });
            const denied = args.flatMap((a, i) => (a === '--deny-tool' ? [args[i + 1]] : []));
            expect(denied).toEqual(expect.arrayContaining(['shell(git commit)', 'shell(git push)', 'shell(gh)']));
            expect(args).toContain('--allow-all-tools');
        });
    }
});
