import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../routes/events.js', () => ({
    eventsRoutes: async () => undefined,
    broadcastSSE: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTestDb, testDb, truncateAll } from '../../tests/_pg-db.js';
import { insertItem, insertProject, insertProjectRepo } from '../../tests/_items.js';
import { tasksService } from './tasks.js';
import { computeWorktreePath } from './worktree-orchestrator.js';

// Deleting a Task removes the checkouts its runs left (a push_code:false run
// keeps them on purpose while the Task exists). Real git in tmpdir.

const exec = promisify(execFile);
let root: string;
let clone: string;

const git = (cwd: string, ...args: string[]) =>
    exec('git', ['-C', cwd, ...args], { timeout: 20_000 });
const branches = async () =>
    (await git(clone, 'branch', '--format=%(refname:short)')).stdout.trim().split('\n');

async function worktree(path: string, branch: string): Promise<void> {
    await git(clone, 'worktree', 'add', '-b', branch, path, 'main');
    writeFileSync(join(path, 'work.txt'), 'unpushed\n');
    await git(path, 'add', '-A');
    await git(path, 'commit', '-m', 'work');
}

async function insertRun(
    id: string,
    itemId: string,
    branch: string,
    worktreePath: string,
    status = 'completed'
): Promise<void> {
    await testDb
        .insertInto('workflow_runs')
        .values({
            id,
            workflow_id: 'wf-1',
            item_id: itemId,
            project_id: 'p1',
            graph_snapshot: '{"nodes":[],"edges":[]}',
            branch,
            worktree_path: worktreePath,
            status,
        } as never)
        .execute();
}

beforeEach(async () => {
    await truncateAll();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-task-delete-')));
    clone = join(root, 'core');
    mkdirSync(clone);
    await exec('git', ['init', '--initial-branch=main', clone]);
    for (const [k, v] of [
        ['user.email', 't@atlas.local'],
        ['user.name', 'Atlas Test'],
        ['commit.gpgsign', 'false'],
    ] as const)
        await git(clone, 'config', k, v);
    writeFileSync(join(clone, 'README.md'), '# core\n');
    await git(clone, 'add', '-A');
    await git(clone, 'commit', '-m', 'init');
    await insertProject('p1', 'ATL', { git_path: clone });
    await testDb
        .insertInto('workflows')
        .values({
            id: 'wf-1',
            project_id: 'p1',
            name: 'Dev',
            graph: '{"nodes":[],"edges":[]}',
        } as never)
        .execute();
    await insertItem({ id: 'ATL-1', type: 'task', project_id: 'p1', title: 'Task' });
    await insertItem({
        id: 'ATL-2',
        type: 'sub_task',
        project_id: 'p1',
        parent_id: 'ATL-1',
        parent_type: 'task',
        title: 'Sub',
    });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
    await closeTestDb();
});

describe('tasksService.delete — checkouts', () => {
    it("removes the Task's workflow-run worktree and a sub-task's own worktree, with their local branches; the clone stays", async () => {
        const runPath = computeWorktreePath(clone, 'p1', 'atlas/wf/ATL-1');
        await worktree(runPath, 'atlas/wf/ATL-1');
        await insertRun('wr-1', 'ATL-1', 'atlas/wf/ATL-1', runPath);
        const subPath = computeWorktreePath(clone, 'p1', 'atlas/coder/ATL-2');
        await worktree(subPath, 'atlas/coder/ATL-2');
        await testDb
            .updateTable('items')
            .set({ worktree_branch: 'atlas/coder/ATL-2', worktree_path: subPath })
            .where('id', '=', 'ATL-2')
            .execute();

        await tasksService.delete('ATL-1');

        await vi.waitFor(
            () => expect([existsSync(runPath), existsSync(subPath)]).toEqual([false, false]),
            { timeout: 15_000 }
        );
        await vi.waitFor(async () => expect(await branches()).toEqual(['main']), {
            timeout: 15_000,
        });
        expect(existsSync(join(clone, 'README.md'))).toBe(true);
    });

    it("keeps a running run's worktree — its agent is still in there", async () => {
        const runPath = computeWorktreePath(clone, 'p1', 'atlas/wf/ATL-1');
        await worktree(runPath, 'atlas/wf/ATL-1');
        await insertRun('wr-1', 'ATL-1', 'atlas/wf/ATL-1', runPath, 'running');

        await tasksService.delete('ATL-1');

        await new Promise((r) => setTimeout(r, 500));
        expect(existsSync(runPath)).toBe(true);
        expect(await branches()).toContain('atlas/wf/ATL-1');
    });

    it("removes a multi-repo Task's workspace folder and each repo's checkout in it", async () => {
        const web = join(root, 'web');
        await exec('git', ['clone', clone, web]);
        await insertProjectRepo('p1', { id: 'repo-web', name: 'web', git_path: web });
        await testDb
            .updateTable('project_repos')
            .set({ name: 'core' })
            .where('id', '=', 'p1')
            .execute();
        await testDb
            .updateTable('items')
            .set({ repo_ids: JSON.stringify(['p1', 'repo-web']) })
            .where('id', '=', 'ATL-1')
            .execute();
        const ws = join(root, 'worktrees', 'p1', 'ws', 'atlas__wf__ATL-1');
        await worktree(join(ws, 'core'), 'atlas/wf/ATL-1');
        await git(web, 'worktree', 'add', '-b', 'atlas/wf/ATL-1', join(ws, 'web'), 'main');
        await insertRun('wr-1', 'ATL-1', 'atlas/wf/ATL-1', ws);

        await tasksService.delete('ATL-1');

        await vi.waitFor(() => expect(existsSync(ws)).toBe(false), { timeout: 15_000 });
        expect(await branches()).toEqual(['main']);
        expect(
            (await git(web, 'branch', '--format=%(refname:short)')).stdout.trim().split('\n')
        ).not.toContain('atlas/wf/ATL-1');
    });

    it('a Task with no runs deletes as before', async () => {
        await tasksService.delete('ATL-1');
        expect(await testDb.selectFrom('items').select('id').execute()).toEqual([]);
    });
});
