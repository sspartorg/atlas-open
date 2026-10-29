import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The web server proxies /api to an API with no login. `vite --host` bound it
// to 0.0.0.0, so anyone on the same Wi-Fi could read Atlas and, with a forged
// Origin header, write — Terminal sessions included. It listens on 127.0.0.1
// unless the Owner opts in with ATLAS_LAN_ACCESS=true.

const WEB = resolve(__dirname, '..');

async function config(lan: string) {
    vi.resetModules();
    vi.stubEnv('ATLAS_LAN_ACCESS', lan);
    const make = (await import('../vite.config.js')).default as unknown as (env: { mode: string; command: string }) => {
        server: { host: unknown };
        preview: { host: unknown };
    };
    return make({ mode: 'development', command: 'serve' });
}

describe('web bind address', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('dev and preview listen on 127.0.0.1 by default', async () => {
        const c = await config('false');
        expect(c.server.host).toBe('127.0.0.1');
        expect(c.preview.host).toBe('127.0.0.1');
    });

    it('ATLAS_LAN_ACCESS=true opens them to the network', async () => {
        const c = await config('true');
        expect(c.server.host).toBe(true);
        expect(c.preview.host).toBe(true);
    });

    it('no start script overrides it with a bare --host', () => {
        const pkg = JSON.parse(readFileSync(resolve(WEB, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        for (const [name, cmd] of Object.entries(pkg.scripts)) expect(cmd, name).not.toMatch(/--host(?!\s+127\.0\.0\.1)/);
        expect(readFileSync(resolve(WEB, 'scripts/serve.mjs'), 'utf8')).not.toContain("'--host'");
    });
});
