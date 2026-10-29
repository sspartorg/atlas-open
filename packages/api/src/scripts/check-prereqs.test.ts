import { describe, it, expect } from 'vitest';
import { meetsMinVersion, parseVersion, runCheck } from './check-prereqs.js';

describe('parseVersion', () => {
    it('parses common output formats', () => {
        expect(parseVersion('v20.11.1\n')).toEqual([20, 11, 1]);
        expect(parseVersion('9.15.0')).toEqual([9, 15, 0]);
        expect(parseVersion('git version 2.43.0.windows.1')).toEqual([2, 43, 0]);
        expect(parseVersion('Docker version 24.0.7, build afdd53b')).toEqual([24, 0, 7]);
    });
    it('returns null when no version found', () => {
        expect(parseVersion('not installed')).toBeNull();
        expect(parseVersion('')).toBeNull();
    });
});

describe('meetsMinVersion', () => {
    it('compares semver tuples', () => {
        expect(meetsMinVersion([20, 0, 0], [20, 0, 0])).toBe(true);
        expect(meetsMinVersion([20, 11, 1], [20, 0, 0])).toBe(true);
        expect(meetsMinVersion([19, 99, 99], [20, 0, 0])).toBe(false);
        expect(meetsMinVersion([9, 1, 0], [9, 0, 0])).toBe(true);
        expect(meetsMinVersion([8, 99, 99], [9, 0, 0])).toBe(false);
    });
});

describe('runCheck', () => {
    it('passes with the first output line', async () => {
        expect(await runCheck({ name: 'n', cmd: 'node', args: ['-e', '"console.log(42)"'] })).toEqual({ ok: true, line: '[ OK ] n: 42' });
    });

    // A stopped Docker engine is not a missing install: say what to do.
    it('fails with the check’s own message when the command exits non-zero', async () => {
        expect(await runCheck({ name: 'docker engine', cmd: 'node', args: ['-e', '"process.exit(1)"'], fail: 'not running' })).toEqual({
            ok: false,
            line: '[FAIL] docker engine: not running',
        });
        expect((await runCheck({ name: 'x', cmd: 'node', args: ['-e', '"process.exit(1)"'] })).line).toBe('[FAIL] x: not installed or not on PATH');
    });
});
