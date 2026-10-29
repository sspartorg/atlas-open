import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeTestDb, testDb, truncateAll } from './_pg-db.js';
import { insertItem, insertProject } from './_items.js';

afterAll(async () => {
    await closeTestDb();
});

describe('truncateAll lock handling', () => {
    it('fails fast naming the blocking query instead of hanging until the hook timeout', async () => {
        const blocker = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
        await blocker.connect();
        try {
            await blocker.query('BEGIN');
            await blocker.query('LOCK TABLE scratch_pad IN SHARE MODE');
            await expect(truncateAll({ lockTimeoutMs: 200, attempts: 2 })).rejects.toThrow(
                /blocked by.*LOCK TABLE scratch_pad/s,
            );
        } finally {
            await blocker.query('ROLLBACK');
            await blocker.end();
        }
        await expect(truncateAll()).resolves.toBeUndefined();
    }, 20_000);

    it('empties the tables CASCADE used to reach and restarts their counters', async () => {
        await truncateAll();
        await insertProject('p1');
        const itemId = await insertItem({ type: 'task', project_id: 'p1', title: 'T' });
        const link = (url = 'https://x/1') =>
            testDb.insertInto('item_external_links').values({ item_id: itemId, link_kind: 'pull_request', url } as never).returning('id').executeTakeFirstOrThrow();
        const first = await link();
        await link('https://x/2');
        await truncateAll();
        expect(await testDb.selectFrom('items').select('id').execute()).toEqual([]);
        expect(await testDb.selectFrom('item_external_links').select('id').execute()).toEqual([]);
        await insertProject('p1');
        await insertItem({ id: itemId, type: 'task', project_id: 'p1', title: 'T' });
        expect((await link()).id).toBe(first.id);
    });
});
