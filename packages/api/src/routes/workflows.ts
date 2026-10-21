import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMcpToken } from '../plugins/mcp-auth.js';
import { ApiError } from '../utils/errors.js';
import { workflowsService } from '../services/workflows.js';
import { WorkflowStartError, cancelWorkflowRun, resumeWorkflowRun } from '../services/workflow-engine.js';
import { DependenciesNotReadyError } from '../services/dependency-guard.js';
import { WorkflowRunDiffNotFound, getWorkflowRunDiff, getWorkflowRunFilePatch } from '../services/workflow-run-diff.js';
import { WorktreeDiffError } from '../services/worktree-diff.js';

function mapStartError(err: unknown): never {
    if (err instanceof WorkflowStartError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
        throw new ApiError(err.code === 'invalid' ? 'validation_error' : err.code, err.message, status);
    }
    if (err instanceof DependenciesNotReadyError) {
        throw new ApiError('conflict', 'This item depends on items that are not done yet', 409, { blockers: err.blockers });
    }
    throw err;
}

// Same bounds as the terminal session's diff/file query (routes/cli-sessions.ts).
const RunDiffFileQuerySchema = z.object({
    repo_id: z.string().min(1).max(200),
    path: z.string().min(1).max(1024),
    scope: z.enum(['uncommitted', 'committed']),
    context: z.coerce.number().int().min(0).max(25).default(3),
});

function mapDiffError(err: unknown): never {
    if (err instanceof WorkflowRunDiffNotFound) throw new ApiError('not_found', err.message, 404);
    if (err instanceof WorktreeDiffError) {
        const invalid = err.code === 'invalid_path';
        throw new ApiError(invalid ? 'validation_error' : 'conflict', err.message, invalid ? 400 : 409, { code: err.code });
    }
    /* v8 ignore next -- anything else is a real 500 for the global handler */
    throw err;
}

export async function workflowsRoutes(app: FastifyInstance) {
    app.get('/api/workflow-runs/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const run = await workflowsService.getRun(id);
        if (!run) throw new ApiError('not_found', 'Run not found', 404);
        return reply.send(run);
    });

    app.get('/api/workflow-runs/:id/diff', async (req, reply) => {
        const { id } = req.params as { id: string };
        const diff = await getWorkflowRunDiff(id).catch(mapDiffError);
        if (!diff) throw new ApiError('not_found', 'Run not found', 404);
        return reply.send(diff);
    });

    app.get('/api/workflow-runs/:id/diff/file', async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = RunDiffFileQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) throw new ApiError('validation_error', 'Invalid query', 400, { issues: parsed.error.issues });
        const q = parsed.data;
        const patch = await getWorkflowRunFilePatch({
            runId: id,
            repoId: q.repo_id,
            scope: q.scope,
            path: q.path,
            context: q.context,
        }).catch(mapDiffError);
        return reply.send(patch);
    });

    app.post('/api/workflow-runs/:id/stop', { preHandler: requireMcpToken }, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!(await workflowsService.getRun(id))) throw new ApiError('not_found', 'Run not found', 404);
        await cancelWorkflowRun(id);
        return reply.send(await workflowsService.getRun(id));
    });

    app.post('/api/workflow-runs/:id/resume', { preHandler: requireMcpToken }, async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!(await workflowsService.getRun(id))) throw new ApiError('not_found', 'Run not found', 404);
        try {
            await resumeWorkflowRun(id);
        } catch (err) {
            mapStartError(err);
        }
        return reply.send(await workflowsService.getRun(id));
    });

    app.get('/api/items/:id/workflow-runs', async (req, reply) => {
        const { id } = req.params as { id: string };
        return reply.send(await workflowsService.listRunsForItem(id));
    });
}
