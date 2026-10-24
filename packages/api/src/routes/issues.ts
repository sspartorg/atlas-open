import type { FastifyInstance } from 'fastify';
import { buildIssueTree } from '../services/issue-tree.js';

export async function issuesRoutes(app: FastifyInstance) {
    app.get('/api/issues/tree', async (req, reply) => {
        const { project_id } = req.query as { project_id?: string };
        return reply.send(await buildIssueTree({ projectId: project_id }));
    });
}
