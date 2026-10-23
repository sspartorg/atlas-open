import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyRunCommits } from './commit-verifier.js';
import { testDb, truncateAll, closeTestDb } from '../../tests/_pg-db.js';
import { insertProject, insertItem } from '../../tests/_items.js';
import { agentsService } from './agents.js';

const execFileP = promisify(execFile);

// Build a throwaway git repo per test so we can run real `git log`
// against it. The verifier shells out to git, so unit-style mocking
// would just test the mock; an actual repo with controlled commits
// is the honest fixture.
async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cvt-'));
    await execFileP('git', ['init', '-b', 'main'], { cwd: dir });
    await execFileP('git', ['config', 'user.email', 'test@local'], { cwd: dir });
    await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir });
    // Commit signing config — turn off in case the host has it on.
    await execFileP('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    return dir;
}

async function gitCommit(dir: string, file: string, content: string, message: string): Promise<void> {
    await writeFile(join(dir, file), content, 'utf8');
    await execFileP('git', ['add', file], { cwd: dir });
    await execFileP('git', ['commit', '-m', message], { cwd: dir });
}

let repos: string[] = [];

beforeEach(async () => {
    await truncateAll();
    repos = [];
});

afterEach(async () => {
    for (const dir of repos) {
        await rm(dir, { recursive: true, force: true });
    }
});

afterAll(async () => {
    await closeTestDb();
});

const agentBase = {
    name: 'Coder',
    category: 'software-dev' as const,
    cli: 'claude' as const,
    model: 'claude-opus-4-7',
    framework: '',
    prompt_md: '',
    accent_color: '#000',
    sort_order: 1,
};

async function seedItem(): Promise<string> {
    const agent = await agentsService.create(agentBase);
    await insertProject('p1', 'ATL');
    await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'E' });
    return agent.id;
}

// ADR 0015 — agents only edit files; Atlas commits after the verifier runs.
describe('verifyRunCommits', () => {
    it('clean — no commits, no dirty tree', async () => {
        const dir = await makeRepo();
        repos.push(dir);
        const agentId = await seedItem();

        const out = await verifyRunCommits({
            runId: 'run-1',
            agentId,
            itemId: 'ATL-1',
            cwd: dir,
            runStartedAtIso: new Date(Date.now() - 60_000).toISOString(),
            itemType: 'task',
        });
        expect(out.result).toBe('clean');

        const row = await testDb
            .selectFrom('commit_verifications')
            .selectAll()
            .where('run_id', '=', 'run-1')
            .executeTakeFirstOrThrow();
        expect(row.result).toBe('clean');
        expect(row.commit_count).toBe(0);
    });

    it('compliant — files changed and left uncommitted for Atlas, no comment posted', async () => {
        const dir = await makeRepo();
        repos.push(dir);
        await gitCommit(dir, 'README.md', 'init\n', 'chore: init');
        await writeFile(join(dir, 'dirty.txt'), 'uncommitted', 'utf8');
        const agentId = await seedItem();

        const out = await verifyRunCommits({
            runId: 'run-2',
            agentId,
            itemId: 'ATL-1',
            cwd: dir,
            runStartedAtIso: new Date(Date.now() + 60_000).toISOString(), // after init commit
            itemType: 'task',
        });
        expect(out).toEqual({ result: 'compliant', commitCount: 0, problems: [] });
        const comments = await testDb.selectFrom('comments').selectAll().where('item_id', '=', 'ATL-1').execute();
        expect(comments).toHaveLength(0);
    });

    it('partial — the agent committed, whatever the message', async () => {
        const dir = await makeRepo();
        repos.push(dir);
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        await gitCommit(dir, 'a.txt', 'A\n', 'feat(api): add a thing\n\nRefs: ATL-1');
        const agentId = await seedItem();

        const out = await verifyRunCommits({
            runId: 'run-3',
            agentId,
            itemId: 'ATL-1',
            cwd: dir,
            runStartedAtIso: sinceIso,
            itemType: 'task',
        });
        expect(out.result).toBe('partial');
        expect(out.commitCount).toBe(1);
        expect(out.problems).toEqual([expect.objectContaining({ reason: 'agent-committed' })]);
    });

    it('clean — non-git cwd records a row without erroring', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'no-git-'));
        repos.push(dir);
        const agentId = await seedItem();

        const out = await verifyRunCommits({
            runId: 'run-6',
            agentId,
            itemId: 'ATL-1',
            cwd: dir,
            runStartedAtIso: new Date().toISOString(),
            itemType: 'task',
        });
        expect(out.result).toBe('clean');
    });

    it('appends a system comment naming the agent commit', async () => {
        const dir = await makeRepo();
        repos.push(dir);
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        await gitCommit(dir, 'd.txt', 'D\n', 'feat(api): agent commit');
        const agentId = await seedItem();

        await verifyRunCommits({
            runId: 'run-7',
            agentId,
            itemId: 'ATL-1',
            cwd: dir,
            runStartedAtIso: sinceIso,
            itemType: 'task',
        });
        const comments = await testDb
            .selectFrom('comments')
            .selectAll()
            .where('item_id', '=', 'ATL-1')
            .execute();
        expect(comments.length).toBeGreaterThan(0);
        expect(comments[0]!.body).toMatch(/commit-discipline verifier: \*\*partial\*\*\. Problems: [0-9a-f]{12}: agent-committed/);
    });

    it('freedom-mode (itemId=null): an agent commit is still flagged, but no comment is posted', async () => {
        const dir = await makeRepo();
        repos.push(dir);
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        await gitCommit(dir, 'f.txt', 'F\n', 'feat(api): freedom commit');
        const agent = await agentsService.create(agentBase);

        const out = await verifyRunCommits({
            runId: 'run-freedom',
            agentId: agent.id,
            itemId: null,
            cwd: dir,
            runStartedAtIso: sinceIso,
            itemType: null,
        });
        expect(out.result).toBe('partial');
        const comments = await testDb.selectFrom('comments').selectAll().execute();
        expect(comments).toHaveLength(0);
    });
});
