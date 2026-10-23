import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { IProjectRepo } from '@atlas/shared';
import { db } from '../db/kysely-client.js';
import { appLog } from './app-log.js';
import { projectReposService } from './project-repos.js';
import { cleanupWorktreeAfterPush, computeWorktreePath } from './worktree-orchestrator.js';

export interface RunRepo {
    repo: IProjectRepo;
    /** This run's checkout of the repo. */
    path: string;
}

export interface RunRepos {
    repos: RunRepo[];
    /**
     * Multi-repo Task: the folder holding one checkout per repo, named by repo
     * — it is the agents' cwd and `workflow_runs.worktree_path`. Null for a
     * single repo, whose checkout is the cwd, exactly as before ADR 0017.
     */
    workspace: string | null;
}

/**
 * ADR 0017 — the repos a run works on and where each is checked out. A
 * sub-task's run works on its Task's repos, in the Task's workspace.
 */
export async function runRepos(run: {
    project_id: string | null;
    item_id: string | null;
    branch: string | null;
    /** A single repo's checkout is wherever the run recorded it. */
    worktree_path?: string | null;
}): Promise<RunRepos> {
    if (!run.project_id || !run.branch) return { repos: [], workspace: null };
    let repoIds: string[] = [];
    if (run.item_id) {
        const item = await db
            .selectFrom('items')
            .select(['id', 'parent_id', 'repo_ids'])
            .where('id', '=', run.item_id)
            .executeTakeFirst();
        const task = item?.parent_id
            ? await db.selectFrom('items').select('repo_ids').where('id', '=', item.parent_id).executeTakeFirst()
            : item;
        repoIds = task?.repo_ids ?? [];
    } else {
        // ponytail: keyed by branch so every caller (most pass no run id)
        // finds it; a project-scope branch is `atlas/wf/<run id prefix>`.
        const row = await db
            .selectFrom('workflow_runs')
            .select('repo_ids')
            .where('project_id', '=', run.project_id)
            .where('branch', '=', run.branch)
            .where('item_id', 'is', null)
            .orderBy('started_at', 'desc')
            .executeTakeFirst();
        repoIds = row?.repo_ids ?? [];
    }
    const repos = await projectReposService.forTask({ project_id: run.project_id, repo_ids: repoIds });
    const [only] = repos;
    if (repos.length === 1 && only) {
        const path = run.worktree_path ?? computeWorktreePath(only.git_path, only.id, run.branch);
        return { repos: [{ repo: only, path }], workspace: null };
    }
    const [first] = repos;
    /* v8 ignore next -- forTask returns at least one repo unless the project has none */
    if (!first) return { repos: [], workspace: null };
    // ADR 0018 — no primary to hang the workspace off, so it sits next to the
    // Task's first repo (every clone lands in the Atlas workspace folder, so
    // that is the same place as before). `ws/` keeps it apart from any
    // single-repo checkout of the same branch left next to it.
    const workspace = join(
        dirname(resolve(first.git_path)),
        'worktrees',
        run.project_id,
        'ws',
        run.branch.replace(/\//g, '__')
    );
    // Repo names are unique per project (project_repos_project_name_unique),
    // so the folder names inside the workspace are too.
    return { repos: repos.map((repo) => ({ repo, path: join(workspace, repo.name) })), workspace };
}

/**
 * Appended to a multi-repo run's `.atlas/current-task.md` — the file the
 * agent CLI reads — so agents know where each repo is and how to work them.
 */
export function repositoriesMarkdown(repos: RunRepo[], branch: string | null): string {
    const [first] = repos;
    return [
        '',
        '## Repositories',
        '',
        `This Task spans ${repos.length} repos, each checked out in its own folder here on branch \`${branch ?? ''}\`:`,
        '',
        '| Folder | Remote | Base branch |',
        '|---|---|---|',
        ...repos.map(
            (r, i) => `| \`./${basename(r.path)}\`${i === 0 ? ' (first)' : ''} | ${r.repo.git_url || '-'} | \`${r.repo.default_branch}\` |`
        ),
        '',
        '- This folder is not a git repo. Change each file in the repo it belongs to; do not commit — Atlas commits each repo you changed.',
        '- Run each guard-rail script from inside the repo you changed: `(cd ./<repo> && bash ./.atlas/scripts/bash/check-<id>.sh)`.',
        `- Put Task-wide files (notes, docs) in the first repo, \`./${first ? basename(first.path) : ''}\`.`,
        '- When your run ends, Atlas commits, pushes the branch and opens one pull request per repo you changed.',
        '- **This shared parent folder is temporary.** It is deleted at teardown, and each repo is merged and built on its own. Never import or require across repos by relative path (`../<other-repo>/...`) and never point a config or test fixture at a sibling folder — it resolves here and nowhere else, so the test passes in this run and fails in CI, in a fresh clone, and after merge. Cross-repo agreement is asserted by duplicating the expected values in each repo, not by reaching across.',
        '',
    ].join('\n');
}

export interface TaskCheckouts {
    checkouts: Array<{ repo: IProjectRepo; path: string; branch: string }>;
    workspaces: string[];
}

/**
 * Every checkout a Task and its sub-tasks left on disk, read while the rows
 * still exist: each workflow run's, and each item's own direct-run worktree.
 * A sub-task's run shares its Task's checkout, so this is only safe for a
 * whole Task. A `running` run is skipped — its agent is still in there.
 */
export async function taskCheckouts(taskId: string): Promise<TaskCheckouts> {
    const items = await db
        .selectFrom('items')
        .select(['id', 'project_id', 'worktree_branch', 'worktree_path'])
        .where((eb) => eb.or([eb('id', '=', taskId), eb('parent_id', '=', taskId)]))
        .execute();
    if (items.length === 0) return { checkouts: [], workspaces: [] };
    const runs = await db
        .selectFrom('workflow_runs')
        .select(['item_id', 'project_id', 'branch', 'worktree_path', 'status'])
        .where('item_id', 'in', items.map((i) => i.id))
        .where('branch', 'is not', null)
        .execute();
    const live = new Set(runs.filter((r) => r.status === 'running').map((r) => r.branch));
    const sources = [
        ...runs.map((r) => ({ project_id: r.project_id, item_id: r.item_id, branch: r.branch, worktree_path: r.worktree_path })),
        ...items.map((i) => ({ project_id: i.project_id, item_id: i.id, branch: i.worktree_branch, worktree_path: i.worktree_path })),
    ].filter((s) => s.branch && !live.has(s.branch));

    const checkouts = new Map<string, TaskCheckouts['checkouts'][number]>();
    const workspaces = new Set<string>();
    for (const source of sources) {
        const { repos, workspace } = await runRepos(source);
        for (const { repo, path } of repos) checkouts.set(path, { repo, path, branch: source.branch ?? '' });
        if (workspace) workspaces.add(workspace);
    }
    return { checkouts: [...checkouts.values()], workspaces: [...workspaces] };
}

/** Remove what `taskCheckouts` found: each worktree and its local branch, then any multi-repo workspace folder. */
export async function removeTaskCheckouts({ checkouts, workspaces }: TaskCheckouts): Promise<void> {
    for (const { repo, path, branch } of checkouts) {
        if (!repo.git_path || !existsSync(path)) continue;
        const { warnings } = await cleanupWorktreeAfterPush({
            itemId: null,
            projectId: repo.id,
            repoGitPath: repo.git_path,
            worktreePath: path,
            branch,
            credentialId: null,
        });
        if (warnings.length) appLog().warn({ path, warnings }, '[task-delete] worktree cleanup');
    }
    for (const w of workspaces) rmSync(w, { recursive: true, force: true });
}
