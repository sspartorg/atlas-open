// Task runner (atlas-open): one Task, one agent.
//
// A Task with an assigned agent and status `ready` is dispatched here. The run
// owns one worktree + branch for its whole life, spawns the Task's agent once
// through `spawnAgentRun`, and delivers (commit, push, PR) when that agent
// finishes. The run record is a `workflow_runs` row on the built-in `solo`
// workflow (migration 020) whose frozen `graph_snapshot` is always
// start → agent → end.
//
// Git helpers (`ensureWorktree`, `pushWorktree`, `openPullRequest`,
// `cleanupWorktreeAfterPush`) each take `withProjectGitLock` internally and
// the lock is not re-entrant — never wrap them in another lock here.

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    type IRunOutcome,
    type IWorkflowGraph,
    type IWorkflowNode,
    type IssueType,
    type WorkflowParkKind,
    type WorkflowRunStatus,
} from '@atlas/shared';
import { sql } from 'kysely';
import { db } from '../db/kysely-client.js';
import { broadcastSSE } from '../routes/events.js';
import { eventsLog } from './events-log.js';
import { notificationsService, plainNotice } from './notifications.js';
import { sendExternalForNotification } from './external-notifications.js';
import { appLog } from './app-log.js';
import { externalLinks, parseGithubPrUrl, fetchGithubPrTitle } from './external-links.js';
import { commentsService } from './comments.js';
import { assertDepsAllDoneForDispatch } from './dependency-guard.js';
import { decideRunRouting } from './agent-runner-outcome-routing.js';
import { recordRunEvent } from './workflow-run-events.js';
import {
    WORKTREE_BRANCH_RE,
    ensureWorktree,
    pushWorktree,
    openPullRequest,
    cleanupWorktreeAfterPush,
} from './worktree-orchestrator.js';
import { buildGitAuth, cleanupGitConfig } from './git-credentials.js';
import { gitInvokeEnv } from './git-env.js';
import { runRepos } from './run-repos.js';
import { stageArgs } from './atlas-artifacts.js';
import { spawnAgentRun, cancelRun } from './agent-runner.js';
import { isRetryableStepError } from './step-error-retry.js';

const exec = promisify(execFile);

/** The built-in run record every Task run belongs to (migration 020). */
export const SOLO_WORKFLOW_ID = 'solo';

/** How many Tasks run at once across the install. */
export const MAX_PARALLEL_RUNS = 3;

// A `running` run with no live step for this long is presumed orphaned (API
// restart, a terminal path that never reported back). Longer than the worst
// push + PR so delivery isn't mistaken for a hang.
export const WORKFLOW_RECONCILE_AFTER_MS = 10 * 60 * 1000;

// How long a crashed step waits before its one automatic retry. Long enough
// for a dropped connection or a restarting API to come back; far inside the
// reconcile window above, so the waiting run is never mistaken for an orphan.
export const STEP_RETRY_BACKOFF_MS = 30 * 1000;

export type WorkflowStartErrorCode = 'not_found' | 'invalid' | 'conflict';

export class WorkflowStartError extends Error {
    constructor(
        public readonly code: WorkflowStartErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'WorkflowStartError';
    }
}

interface RunRow {
    id: string;
    workflow_id: string;
    item_id: string | null;
    project_id: string | null;
    status: WorkflowRunStatus;
    graph_snapshot: IWorkflowGraph;
    current_node_id: string | null;
    parked_node_id: string | null;
    branch: string | null;
    worktree_path: string | null;
    setup_done: boolean;
    started_at: string;
}

const AGENT_NODE = 'agent';
const END_NODE = 'end';

/** The only graph a run walks: the Task's agent, then delivery. */
export function soloGraph(agentId: string): IWorkflowGraph {
    return {
        nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 } },
            { id: AGENT_NODE, type: 'agent', agent_id: agentId, position: { x: 0, y: 140 } },
            { id: END_NODE, type: 'end', position: { x: 0, y: 280 } },
        ],
        edges: [
            { id: 'e1', source: 'start', target: AGENT_NODE, kind: 'pass' },
            { id: 'e2', source: AGENT_NODE, target: END_NODE, kind: 'pass' },
        ],
    };
}

async function loadRun(runId: string): Promise<RunRow | undefined> {
    const row = await db.selectFrom('workflow_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    return row as unknown as RunRow | undefined;
}

async function loadItem(itemId: string) {
    return db
        .selectFrom('items')
        .select(['id', 'type', 'title', 'status', 'project_id', 'worktree_branch', 'assignee_agent_id', 'repo_ids'])
        .where('id', '=', itemId)
        .executeTakeFirst();
}

function nodeById(graph: IWorkflowGraph, nodeId: string | null): IWorkflowNode | undefined {
    return graph.nodes.find((n) => n.id === nodeId);
}

function broadcastRun(run: Pick<RunRow, 'id' | 'workflow_id' | 'item_id'>, status: WorkflowRunStatus, nodeId: string | null): void {
    broadcastSSE({
        type: 'workflow_run_updated',
        workflowId: run.workflow_id,
        workflowRunId: run.id,
        workflowRunStatus: status,
        nodeId,
        ...(run.item_id ? { issueId: run.item_id } : {}),
    });
}

async function setItemStatus(itemId: string, to: string, detail: string): Promise<void> {
    const item = await loadItem(itemId);
    if (!item) return;
    await db.updateTable('items').set({ status: to }).where('id', '=', itemId).execute();
    if (item.status !== to) {
        await eventsLog.record({
            item_id: itemId,
            item_type: item.type as IssueType,
            event_type: 'status_changed',
            actor_agent_id: null,
            field: 'status',
            from_value: item.status,
            to_value: to,
            detail,
        });
    }
    broadcastSSE({ type: 'counts_changed', issueType: item.type as IssueType, issueId: itemId });
}

type OwnerEventKey =
    | 'item.status_changed:waiting_for_info'
    | 'item.status_changed:in_review'
    | 'workflow.finished'
    | 'workflow.failed';

async function notifyOwner(
    run: RunRow,
    message: string,
    kind: 'needs_you' | 'update',
    eventKey: OwnerEventKey | null,
): Promise<void> {
    try {
        const item = run.item_id ? await loadItem(run.item_id) : undefined;
        const notification = await notificationsService.create({
            event_key: eventKey,
            event_type: 'workflow_run',
            message: plainNotice(message),
            issue_type: (item?.type as IssueType | undefined) ?? null,
            issue_id: run.item_id,
            agent_id: null,
            kind,
            link_url: run.item_id ? `/tasks/${run.item_id}` : null,
        });
        if (eventKey) await sendExternalForNotification(notification.id, notification.message, eventKey);
    } catch (err) {
        // Best-effort (a notification must never wedge a run), but not silent.
        appLog().warn({ err, runId: run.id }, '[task-run] owner notification failed');
    }
}

// ─── Start ──────────────────────────────────────────────────────────────────

export async function startTaskRun(itemId: string): Promise<string> {
    const item = await loadItem(itemId);
    if (!item) throw new WorkflowStartError('not_found', 'Item not found');
    if (item.type !== 'task') throw new WorkflowStartError('invalid', 'Only Tasks run');
    if (item.status === 'done') throw new WorkflowStartError('invalid', 'Item is already done');
    const agentId = item.assignee_agent_id;
    if (!agentId) throw new WorkflowStartError('invalid', 'Assign an agent to this Task to run it');
    // ADR 0018 — a Task's repos can be removed out from under it.
    if ((item.repo_ids ?? []).length === 0) throw new WorkflowStartError('invalid', 'This Task has no repos — add one to the project first');
    await assertDepsAllDoneForDispatch(item.id, agentId);

    // Migration 020 seeds the FK anchor; a wipe of `workflows` (a test
    // truncate, a hand cleanup) must not stop every Task from running.
    await db
        .insertInto('workflows')
        .values({ id: SOLO_WORKFLOW_ID, name: 'Single agent', status: 'inactive', input_kind: 'none', trigger: 'manual', use_worktree: false })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

    const runId = randomUUID();
    const branch = item.worktree_branch && WORKTREE_BRANCH_RE.test(item.worktree_branch) ? item.worktree_branch : `atlas/task/${item.id}`;
    try {
        await db
            .insertInto('workflow_runs')
            .values({
                id: runId,
                workflow_id: SOLO_WORKFLOW_ID,
                item_id: item.id,
                project_id: item.project_id,
                graph_snapshot: JSON.stringify(soloGraph(agentId)),
                branch,
            })
            .execute();
    } catch (err) {
        if ((err as { code?: string }).code === '23505') {
            throw new WorkflowStartError('conflict', `Item ${itemId} already has a live run`);
        }
        throw err;
    }
    const run = (await loadRun(runId)) as RunRow;
    broadcastRun(run, 'running', null);

    await setItemStatus(item.id, 'in_progress', 'run_started');
    if (branch !== item.worktree_branch) {
        await db.updateTable('items').set({ worktree_branch: branch }).where('id', '=', item.id).execute();
    }

    const failure = await prepareWorktree(run);
    if (failure) {
        await parkFailed(run, AGENT_NODE, `Could not prepare the worktree: ${failure}`, 'setup_failed');
        return runId;
    }
    await spawnNode(run);
    return runId;
}

/**
 * Provisions the run's worktree, or — when it already exists — brings the
 * branch onto the latest default branch (ensureWorktree pulls ff-only and
 * rebases its commits onto fresh origin/<default>). Returns why it failed, or
 * null. ensureWorktree discards uncommitted files, so the agent's edits are committed
 * first.
 */
async function prepareWorktree(run: RunRow): Promise<string | null> {
    if (!run.branch || !run.project_id) return null;
    const branch = run.branch;
    try {
        // ADR 0017 — one checkout per repo of the Task; several sit side by
        // side in one workspace, which becomes the run's worktree_path (cwd).
        const { repos, workspace } = await runRepos(run);
        for (const { repo, path } of repos) {
            if (!repo.git_path) {
                throw new Error(workspace ? `Repo ${repo.name} has no cloned repository on disk` : 'Project has no cloned repository on disk');
            }
            if (run.worktree_path) await commitPending(path, repo.credential_id, await commitMessage(run));
            // item: null — the path lives on workflow_runs only. Writing it to
            // items.worktree_path would let the boot orphan reaper push and
            // delete the worktree mid-run.
            const wt = await ensureWorktree({
                item: null,
                branch,
                repo: {
                    id: repo.id,
                    git_path: repo.git_path,
                    credential_id: repo.credential_id,
                    default_branch: repo.default_branch,
                },
                pushUpstream: true,
                ...(workspace ? { path } : {}),
            });
            run.worktree_path = workspace ?? wt.path;
            // Written per repo: preparing several can outlast the reconciler's
            // idle window, and updated_at is what it watches.
            await db
                .updateTable('workflow_runs')
                .set({ worktree_path: run.worktree_path, updated_at: new Date().toISOString() })
                .where('id', '=', run.id)
                .execute();
        }
        return null;
    } catch (err) {
        return (err as Error).message;
    }
}

// ─── The agent step ─────────────────────────────────────────────────────────

async function spawnNode(run: RunRow, retryOf?: string): Promise<void> {
    const node = nodeById(run.graph_snapshot, AGENT_NODE);
    const agent = node?.agent_id
        ? await db.selectFrom('agents').select(['id', 'name', 'status']).where('id', '=', node.agent_id).executeTakeFirst()
        : undefined;
    if (!agent || agent.status !== 'active') {
        await parkFailed(run, AGENT_NODE, `Agent ${node?.agent_id ?? '(none)'} is missing or inactive`, 'missing_agent');
        return;
    }
    await db
        .updateTable('workflow_runs')
        .set({ current_node_id: AGENT_NODE, status: 'running', parked_node_id: null, park_reason: null })
        .where('id', '=', run.id)
        .execute();
    run.current_node_id = AGENT_NODE;
    const item = run.item_id ? await loadItem(run.item_id) : undefined;
    broadcastRun(run, 'running', AGENT_NODE);
    try {
        await spawnAgentRun({
            agentId: agent.id,
            issueType: (item?.type as IssueType | undefined) ?? null,
            issueId: item?.id ?? null,
            projectId: item ? null : run.project_id,
            workflowRun: {
                id: run.id,
                nodeId: AGENT_NODE,
                worktreePath: run.worktree_path,
                branch: run.branch,
                skipSetup: run.setup_done,
                ...(retryOf ? { retryOf } : {}),
            },
        });
    } catch (err) {
        await parkFailed(run, AGENT_NODE, `Could not start ${agent.name}: ${(err as Error).message}`, 'dispatch_failed');
    }
}

/**
 * Called by the runner at every terminal exit of an agent run (completed,
 * error, setup_failed, cancelled — including sweeps that never reach
 * completeRun). Runs outside a Task run return immediately.
 */
export async function onStepFinished(agentRunId: string): Promise<void> {
    const step = await db
        .selectFrom('agent_runs')
        .select([
            'workflow_run_id',
            'node_id',
            'agent_id',
            'status',
            'outcome_kind',
            'outcome_summary',
            'outcome_reason',
            'outcome_checklist',
            'parent_run_id',
        ])
        .where('id', '=', agentRunId)
        .executeTakeFirst();
    if (!step?.workflow_run_id || !step.node_id) return;
    const run = await loadRun(step.workflow_run_id);
    // A stale report (the run already moved on, was stopped or parked) must
    // not advance anything.
    if (!run || run.status !== 'running' || run.current_node_id !== step.node_id) return;

    if (step.status === 'cancelled') {
        await cancelWorkflowRun(run.id);
        return;
    }
    if (step.status === 'setup_failed') {
        await parkFailed(run, step.node_id, 'Project setup script failed', 'setup_failed');
        return;
    }
    if (step.status === 'error') {
        // The runner, reaper and watchdog each leave a tagged line in
        // output_text; the Owner needs it to decide whether to just reply.
        const row = await db.selectFrom('agent_runs').select('output_text').where('id', '=', agentRunId).executeTakeFirst();
        const line = row?.output_text
            ?.split('\n')
            .reverse()
            .find((l) => l.startsWith('[ERROR]') || l.startsWith('[watchdog]'));
        const detail = line?.replace(/^\[ERROR\]\s*/, '').slice(0, 300);
        // One automatic retry. The retry carries the crashed step in
        // `parent_run_id`, so a step that has one IS the retry: it parks.
        const retried = step.parent_run_id !== null;
        if (!retried && isRetryableStepError(row?.output_text)) {
            await scheduleStepRetry(run, agentRunId);
            return;
        }
        const what = retried ? 'The agent errored again after an automatic retry' : 'The agent errored';
        await parkFailed(run, step.node_id, detail ? `${what}: ${detail}` : what, 'step_error');
        return;
    }
    if (step.status !== 'completed') return;

    if (!run.setup_done) {
        await db.updateTable('workflow_runs').set({ setup_done: true }).where('id', '=', run.id).execute();
        run.setup_done = true;
    }

    const outcome: IRunOutcome | null = step.outcome_kind
        ? {
              kind: step.outcome_kind,
              ...(step.outcome_summary ? { summary: step.outcome_summary } : {}),
              ...(step.outcome_reason ? { reason: step.outcome_reason } : {}),
              ...(step.outcome_checklist ? { checklist: step.outcome_checklist } : {}),
          }
        : null;

    const checklistRows = await db
        .selectFrom('agent_checklists')
        .select(['id', 'label'])
        .where('agent_id', '=', step.agent_id)
        .where('required', '=', true)
        .execute();
    // agent_checklists.id is bigint → pg returns a string.
    const requiredChecklist = checklistRows.map((r) => ({ id: Number(r.id), label: r.label as string }));
    const decision = decideRunRouting({ outcome, requiredChecklist });

    if (decision.kind === 'park_waiting_for_info') {
        await park(
            run,
            step.node_id,
            outcome?.reason ?? decision.detail ?? 'The agent needs input',
            outcome ? 'question' : 'no_outcome',
            Boolean(outcome?.reason),
        );
        return;
    }
    if (decision.kind === 'apply_on_pass') {
        await finishRun(run);
        return;
    }
    // No reviewer to loop back to: a rejection or an unticked required
    // checklist item goes to the Owner, whose reply re-runs the agent.
    await park(
        run,
        step.node_id,
        decision.detail ?? 'The agent rejected the work',
        outcome?.kind === 'done' ? 'checklist_failed' : 'rejected',
        Boolean(outcome?.reason) && decision.detail === outcome?.reason,
    );
}

/**
 * A crashed step gets one more try before the Owner hears about it.
 *
 * ponytail: an in-process timer. An API restart during the 30 s loses it and
 * the run sits with no live step until reconcile parks it ten minutes later.
 * Persist a `retry_at` if that window ever matters.
 */
async function scheduleStepRetry(run: RunRow, crashedStepId: string): Promise<void> {
    const at = new Date(Date.now() + STEP_RETRY_BACKOFF_MS).toISOString();
    await db
        .updateTable('agent_runs')
        .set({ output_text: sql`coalesce(output_text, '') || ${`\n[atlas] Retrying this step automatically at ${at}.`}` as never })
        .where('id', '=', crashedStepId)
        .execute();
    // Stamp updated_at so the reconcile window starts fresh.
    await db.updateTable('workflow_runs').set({ updated_at: new Date().toISOString() }).where('id', '=', run.id).execute();
    setTimeout(() => {
        void retryStep(run.id, crashedStepId).catch((err: unknown) => {
            console.warn(`[task-run-retry] ${run.id}: ${(err as Error).message}`);
        });
    }, STEP_RETRY_BACKOFF_MS).unref();
}

/** Exported for tests: what the backoff timer runs. */
export async function retryStep(runId: string, crashedStepId: string): Promise<void> {
    // The Owner may have stopped the run meanwhile; this retry is then unwanted.
    const run = await loadRun(runId);
    if (!run || run.status !== 'running' || run.current_node_id !== AGENT_NODE) return;
    const live = await db
        .selectFrom('agent_runs')
        .select('id')
        .where('workflow_run_id', '=', runId)
        .where('status', 'in', ['queued', 'in_progress'])
        .executeTakeFirst();
    if (live) return;
    await spawnNode(run, crashedStepId);
}

// ─── Park / resume ──────────────────────────────────────────────────────────

/** A park caused by something breaking (not a question): it goes outward as
 *  `workflow.failed`, with its own toggle. */
function parkFailed(run: RunRow, nodeId: string | null, reason: string, kind: WorkflowParkKind): Promise<void> {
    return park(run, nodeId, reason, kind, false, true);
}

async function park(
    run: RunRow,
    nodeId: string | null,
    reason: string,
    kind: WorkflowParkKind,
    stepPostedReason = false,
    failed = false,
): Promise<void> {
    await db
        .updateTable('workflow_runs')
        .set({ status: 'waiting_for_owner', parked_node_id: nodeId, current_node_id: nodeId, park_reason: reason.slice(0, 1000) })
        .where('id', '=', run.id)
        .execute();
    run.status = 'waiting_for_owner';
    await recordRunEvent(run.id, 'parked', reason, kind);
    broadcastRun(run, 'waiting_for_owner', nodeId);
    const eventKey = failed ? 'workflow.failed' : 'item.status_changed:waiting_for_info';
    if (!run.item_id) {
        await notifyOwner(run, `A run needs you: ${reason}`, 'needs_you', eventKey);
        return;
    }
    await setItemStatus(run.item_id, 'waiting_for_info', `run_parked: ${reason}`.slice(0, 280));
    // A step that asked or rejected already posted this exact reason in its
    // completion comment; a second comment would only repeat it.
    if (!stepPostedReason) {
        const item = await loadItem(run.item_id);
        try {
            await commentsService.create({
                author: 'agent',
                agent_id: null,
                issue_type: item?.type as IssueType,
                issue_id: run.item_id,
                body: `**Atlas** is waiting for you: ${reason}\n\nReply here to continue.`,
            });
        } catch {
            /* the item status + notification already carry the signal */
        }
    }
    await notifyOwner(run, `${run.item_id} needs you: ${reason}`, 'needs_you', eventKey);
}

/** Owner-initiated resume. */
export async function resumeWorkflowRun(runId: string): Promise<void> {
    const updated = await db
        .updateTable('workflow_runs')
        .set({ status: 'running', park_reason: null })
        .where('id', '=', runId)
        .where('status', '=', 'waiting_for_owner')
        .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
        // Already running: a comment on the item may have resumed it a moment
        // ago. Asking again is harmless, so it is not an error (ADR 0029).
        const current = await db.selectFrom('workflow_runs').select('status').where('id', '=', runId).executeTakeFirst();
        if (current?.status === 'running') return;
        throw new WorkflowStartError('conflict', 'Only a run that is waiting for you can be resumed');
    }
    await recordRunEvent(runId, 'resumed');
    const run = (await loadRun(runId)) as RunRow;
    if (run.item_id) await setItemStatus(run.item_id, 'in_progress', 'run_resumed');
    await continueResumedRun(runId);
}

export async function continueResumedRun(runId: string): Promise<void> {
    const run = await loadRun(runId);
    if (!run || run.status !== 'running') return;
    broadcastRun(run, 'running', run.parked_node_id);
    if (run.parked_node_id === END_NODE) {
        // Parked on a failed delivery: retry it against the kept worktree.
        await finishRun(run);
        return;
    }
    // A parked run can wait days. Refresh the branch onto the latest default
    // branch so the agent sees what merged meanwhile.
    const failure = await prepareWorktree(run);
    if (failure) {
        await parkFailed(run, AGENT_NODE, `Could not refresh the worktree onto the latest default branch: ${failure}`, 'setup_failed');
        return;
    }
    // The Owner's reply is in the comment thread the agent reads.
    await spawnNode(run);
}

// ─── Delivery / cancel ──────────────────────────────────────────────────────

/** `<task key>: <task title>`, e.g. `ATL-12: Fix login`. */
async function commitMessage(run: Pick<RunRow, 'id' | 'item_id'>): Promise<string> {
    const item = run.item_id ? await loadItem(run.item_id) : undefined;
    return item ? `${item.id}: ${item.title}` : `Atlas run ${run.id.slice(0, 8)}`;
}

/**
 * The only commit path for a run's work (ADR 0015): agents edit, Atlas commits
 * whatever the worktree holds. A no-op when nothing changed.
 */
async function commitPending(worktreePath: string, credentialId: string | null, message: string): Promise<string | null> {
    const auth = credentialId ? await buildGitAuth(credentialId).catch(() => null) : null;
    const env = gitInvokeEnv(auth?.configPath ?? null);
    try {
        const status = await exec('git', ['-C', worktreePath, 'status', '--porcelain'], { env, timeout: 60_000 });
        if (!status.stdout.trim()) return null;
        await exec('git', ['-C', worktreePath, ...stageArgs()], { env, timeout: 60_000 });
        const args = ['-c', 'core.hooksPath=.husky/_', '-C', worktreePath, 'commit', '-m', message];
        if (auth?.humanName && auth.humanEmail) args.push('--trailer', `Co-Authored-By: ${auth.humanName} <${auth.humanEmail}>`);
        await exec('git', args, { env, timeout: 60_000 });
        return `committed ${message}`;
    } catch (err) {
        return `could not commit: ${(err as Error).message}`;
    } finally {
        if (auth?.configPath) cleanupGitConfig(auth.configPath);
    }
}

interface DeliveryResult {
    pushed: boolean;
    prUrl: string | null;
    /** Every PR opened this delivery, in repo order. `prUrl` is its first. */
    prUrls: string[];
    /** Set when a push or PR did not happen. */
    failure: string | null;
    log: string[];
}

/** False only when git proves the branch has nothing beyond the atlas .gitignore commit. */
async function hasChanges(worktreePath: string, base: string): Promise<boolean> {
    try {
        await exec('git', ['-C', worktreePath, 'diff', '--quiet', `origin/${base}`, 'HEAD', '--', '.', ':!.gitignore'], {
            env: gitInvokeEnv(null),
            timeout: 60_000,
        });
        return false;
    } catch {
        return true;
    }
}

async function deliver(run: RunRow, opts: { openPr: boolean }): Promise<DeliveryResult> {
    const log: string[] = [];
    const result: DeliveryResult = { pushed: false, prUrl: null, prUrls: [], failure: null, log };
    if (!run.worktree_path || !run.branch || !run.project_id) return result;
    const project = await db.selectFrom('projects').select(['id', 'name']).where('id', '=', run.project_id).executeTakeFirst();
    if (!project) return result;
    const branch = run.branch;
    const { repos, workspace } = await runRepos(run);
    const item = run.item_id ? await loadItem(run.item_id) : undefined;
    const title = item ? `[${item.id}] ${String(item.title).slice(0, 80)}` : project.name;
    const agent = item?.assignee_agent_id
        ? await db.selectFrom('agents').select('name').where('id', '=', item.assignee_agent_id).executeTakeFirst()
        : undefined;
    const body = [
        `Opened by Atlas.`,
        '',
        ...(item ? [`- Task: ${item.id}`] : []),
        ...(agent ? [`- Agent: ${agent.name}`] : []),
        `- Run: \`${run.id}\``,
    ].join('\n');
    const message = await commitMessage(run);
    const opened: { repo: (typeof repos)[number]['repo']; path: string; base: string; url: string }[] = [];

    // ADR 0017 — each repo of the Task delivers on its own; a multi-repo Task
    // skips the repos it did not change (their PR would be empty).
    for (const { repo, path } of repos) {
        const tag = workspace ? `${repo.name}: ` : '';
        const base = repo.default_branch?.trim() ? repo.default_branch : 'main';
        const committed = await commitPending(path, repo.credential_id, message);
        if (committed) log.push(tag + committed);
        if (workspace && !(await hasChanges(path, base))) {
            log.push(`${tag}no changes`);
            continue;
        }
        const push = await pushWorktree(path, branch, repo.credential_id, repo.id);
        const pushOk = push.pushed || push.alreadyUpToDate;
        if (push.pushed) result.pushed = true;
        log.push(pushOk ? `${tag}pushed ${branch}` : `${tag}push failed: ${push.error ?? 'unknown'}`);
        if (!pushOk) result.failure ??= `${tag}Push failed: ${push.error ?? 'unknown error'}`;
        if (workspace) await db.updateTable('workflow_runs').set({ updated_at: new Date().toISOString() }).where('id', '=', run.id).execute();

        if (opts.openPr && pushOk) {
            const pr = await openPullRequest({
                worktreePath: path,
                branch,
                base,
                title,
                body,
                credentialId: repo.credential_id,
                projectId: repo.id,
            });
            if (pr.url) {
                opened.push({ repo, path, base, url: pr.url });
                log.push(`${tag}pr: ${pr.url}`);
                if (item) {
                    if (opened.length === 1) await db.updateTable('items').set({ pr_url: pr.url }).where('id', '=', item.id).execute();
                    try {
                        const parsed = parseGithubPrUrl(pr.url);
                        await externalLinks.create({
                            itemId: item.id,
                            url: pr.url,
                            linkKind: 'pull_request',
                            title: await fetchGithubPrTitle(pr.url).catch(() => null),
                            externalRef: parsed?.number ?? null,
                            createdByRunId: null,
                            actorAgentId: null,
                        });
                    } catch (err) {
                        log.push(`${tag}could not link the PR: ${(err as Error).message}`);
                    }
                }
            } else {
                log.push(`${tag}pr failed: ${pr.error ?? 'unknown'}`);
                result.failure ??= `${tag}Pull request failed: ${pr.error ?? 'unknown error'}`;
            }
        }
    }
    result.prUrl = opened[0]?.url ?? null;
    result.prUrls = opened.map((o) => o.url);

    // Each PR names its siblings: they only make sense merged together. An
    // existing PR gets its body edited, so this second pass is safe to repeat.
    if (opened.length > 1) {
        for (const o of opened) {
            const siblings = opened.filter((x) => x !== o).map((x) => `- ${x.repo.name}: ${x.url}`);
            await openPullRequest({
                worktreePath: o.path,
                branch,
                base: o.base,
                title,
                body: [body, '', '**Also part of this Task:**', ...siblings].join('\n'),
                credentialId: o.repo.credential_id,
                projectId: o.repo.id,
            });
        }
    }

    // Any delivery failure keeps the worktrees so a resumed run can retry
    // from exactly this state.
    if (!result.failure) {
        for (const { repo, path } of repos) {
            if (!repo.git_path) continue;
            const cleanup = await cleanupWorktreeAfterPush({
                itemId: null,
                projectId: repo.id,
                repoGitPath: repo.git_path,
                worktreePath: path,
                branch,
                credentialId: repo.credential_id,
            });
            log.push(...cleanup.warnings);
        }
        if (workspace) rmSync(workspace, { recursive: true, force: true });
    }
    return result;
}

async function finishRun(run: RunRow): Promise<void> {
    await db.updateTable('workflow_runs').set({ current_node_id: END_NODE }).where('id', '=', run.id).execute();
    run.current_node_id = END_NODE;
    broadcastRun(run, 'running', END_NODE);
    const delivery = await deliver(run, { openPr: true });
    if (delivery.failure) {
        // Parked at End: fixing the cause (e.g. the project credential) and
        // resuming re-runs delivery against the kept worktree.
        await parkFailed(run, END_NODE, `${delivery.failure}. Resume the run to retry delivery.`, 'delivery_failed');
        return;
    }

    await db
        .updateTable('workflow_runs')
        .set({ status: 'completed', finished_at: new Date().toISOString(), pr_url: delivery.prUrl, pr_urls: JSON.stringify(delivery.prUrls) as never })
        .where('id', '=', run.id)
        .execute();
    broadcastRun(run, 'completed', END_NODE);

    if (run.item_id) {
        const finalStatus = delivery.prUrl ? 'in_review' : 'done';
        await setItemStatus(run.item_id, finalStatus, 'run_completed');
        const suffix = delivery.prUrl ? ` PR: ${delivery.prUrl}` : '';
        await notifyOwner(
            run,
            `Finished ${run.item_id}.${suffix}${delivery.log.length ? ` (${delivery.log.join('; ')})` : ''}`,
            delivery.prUrl ? 'needs_you' : 'update',
            delivery.prUrl ? 'item.status_changed:in_review' : 'workflow.finished',
        );
    }
    // Start the next queued Task now instead of waiting for the next tick.
    void kickWorkflowDispatch('finished');
}

export async function cancelWorkflowRun(runId: string): Promise<void> {
    const updated = await db
        .updateTable('workflow_runs')
        .set({ status: 'cancelled', finished_at: new Date().toISOString() })
        .where('id', '=', runId)
        .where('status', 'in', ['running', 'waiting_for_owner'])
        .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) return;
    const run = (await loadRun(runId)) as RunRow;
    broadcastRun(run, 'cancelled', run.current_node_id);

    const live = await db
        .selectFrom('agent_runs')
        .select('id')
        .where('workflow_run_id', '=', runId)
        .where('status', 'in', ['queued', 'in_progress'])
        .execute();
    for (const step of live) {
        await db
            .updateTable('agent_runs')
            .set({ status: 'cancelled', completed_at: new Date().toISOString() })
            .where('id', '=', step.id)
            .execute();
        await cancelRun(step.id).catch(() => ({ cancelled: false }));
    }

    // Keep what the agent committed, but a stopped run opens no PR.
    try {
        await deliver(run, { openPr: false });
    } catch {
        /* the worktree stays on disk when delivery fails */
    }
    if (run.item_id) await setItemStatus(run.item_id, 'waiting_for_info', 'run_cancelled');
    void kickWorkflowDispatch('finished');
}

// ─── Reconcile + dispatch tick ──────────────────────────────────────────────

export async function reconcileWorkflowRuns(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - WORKFLOW_RECONCILE_AFTER_MS).toISOString();
    const stale = await db
        .selectFrom('workflow_runs as wr')
        .select(['wr.id'])
        .where('wr.status', '=', 'running')
        .where('wr.updated_at', '<', cutoff)
        .where(({ not, exists, selectFrom }) =>
            not(
                exists(
                    selectFrom('agent_runs as ar')
                        .select('ar.id')
                        .whereRef('ar.workflow_run_id', '=', 'wr.id')
                        .where('ar.status', 'in', ['queued', 'in_progress']),
                ),
            ),
        )
        .execute();
    for (const { id } of stale) {
        const run = await loadRun(id);
        if (run) await parkFailed(run, run.current_node_id, 'The agent stopped reporting back (the API may have restarted)', 'lost_step');
    }
    return stale.length;
}

async function oldestReadyItem(): Promise<string | null> {
    const row = await db
        .selectFrom('items as i')
        .select('i.id')
        .where('i.type', '=', 'task')
        .where('i.status', '=', 'ready')
        .where('i.assignee_agent_id', 'is not', null)
        .where(({ not, exists, selectFrom }) =>
            not(
                exists(
                    selectFrom('workflow_runs as wr')
                        .select('wr.id')
                        .whereRef('wr.item_id', '=', 'i.id')
                        .where('wr.status', 'in', ['running', 'waiting_for_owner']),
                ),
            ),
        )
        // One Task at a time per repo (ADR 0029). Two runs in the same checkout
        // edit the same files, so their pull requests conflict.
        .where(sql<boolean>`not exists (
            select 1 from workflow_runs busy
            join items bi on bi.id = busy.item_id
            where busy.status in ('running', 'waiting_for_owner')
              and bi.repo_ids ?| array(select jsonb_array_elements_text(i.repo_ids))
        )`)
        // Skip items still waiting on a depends_on target, so one blocked
        // item doesn't hold the whole queue (startTaskRun would refuse it).
        .where(({ not, exists, selectFrom }) =>
            not(
                exists(
                    selectFrom('item_links as l')
                        .innerJoin('items as t', 't.id', 'l.to_id')
                        .select('l.from_id')
                        .whereRef('l.from_id', '=', 'i.id')
                        .where('l.relation_type', '=', 'depends_on')
                        .where('t.status', '!=', 'done'),
                ),
            ),
        )
        .orderBy('i.updated_at', 'asc')
        // Items updated in one statement share updated_at; tie-break for FIFO.
        .orderBy('i.id', 'asc')
        .limit(1)
        .executeTakeFirst();
    return row?.id ?? null;
}

/**
 * One dispatch pass: start ready Tasks up to `MAX_PARALLEL_RUNS`, each in its
 * own worktree. Parked runs don't hold a slot, so one unanswered question
 * doesn't stall every other Task.
 */
export function tickWorkflowDispatch(): Promise<number> {
    return enqueueDispatch(() => dispatchPass());
}

async function dispatchPass(): Promise<number> {
    const running = await db
        .selectFrom('workflow_runs')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('status', '=', 'running')
        .executeTakeFirst();
    let started = 0;
    for (let free = MAX_PARALLEL_RUNS - Number(running?.n ?? 0); free > 0; free--) {
        const itemId = await oldestReadyItem();
        if (!itemId) break;
        try {
            await startTaskRun(itemId);
            started++;
        } catch (err) {
            // One queue for every Task: a Task that cannot start steps out of
            // it (waiting for the Owner) instead of blocking the ones behind it.
            await setItemStatus(itemId, 'waiting_for_info', `run_start_failed: ${(err as Error).message}`.slice(0, 280));
            await reportDispatchFailure(itemId, (err as Error).message);
        }
    }
    return started;
}

// ponytail: in-memory, so a restart re-notifies once.
const lastDispatchFailure = new Map<string, { message: string; at: number }>();
const DISPATCH_FAILURE_REARM_MS = 60 * 60 * 1000;

/** Notify once per distinct message per Task, re-armed hourly. */
async function reportDispatchFailure(itemId: string, message: string): Promise<void> {
    const seen = lastDispatchFailure.get(itemId);
    const now = Date.now();
    if (seen && seen.message === message && now - seen.at < DISPATCH_FAILURE_REARM_MS) return;
    lastDispatchFailure.set(itemId, { message, at: now });
    try {
        const n = await notificationsService.create({
            event_type: 'workflow_run',
            event_key: 'workflow.failed',
            message: `Could not start ${itemId} — ${message}`,
            kind: 'needs_you',
            agent_id: null,
            issue_type: 'task',
            issue_id: itemId,
            link_url: `/tasks/${itemId}`,
        });
        await sendExternalForNotification(n.id, n.message, 'workflow.failed');
    } catch (err) {
        appLog().warn({ err, itemId }, '[task-dispatch] failure notification failed');
    }
}

// Every dispatch pass — the minute tick and each kick — runs one after
// another. Two overlapping passes could both pick the same ready Task.
let dispatchChain: Promise<unknown> = Promise.resolve();
// The kick waiting behind the current pass, if any: later kicks just join it.
let queuedKick: Promise<void> | null = null;

function enqueueDispatch<T>(pass: () => Promise<T>): Promise<T> {
    const next = dispatchChain.then(pass);
    dispatchChain = next.catch(() => undefined);
    return next;
}

/**
 * Start whatever is dispatchable now instead of waiting for the minute tick.
 * Fire-and-forget — it never throws. The tick stays the fallback.
 */
export function kickWorkflowDispatch(reason: string): Promise<void> {
    queuedKick ??= enqueueDispatch(async () => {
        queuedKick = null;
        try {
            await dispatchPass();
        } catch (err) {
            console.warn(`[task-dispatch] kick (${reason}) failed: ${(err as Error).message}`);
        }
    });
    return queuedKick;
}
