import type { FastifyInstance } from 'fastify';
import { countsService } from '../services/counts.js';
import { normalizeTz } from '../services/analytics-window.js';
import { getQueue } from '../services/queue.js';

export async function countsRoutes(app: FastifyInstance) {
    app.get('/api/counts', async (_req, reply) => {
        return reply.send(await countsService.getSidenavCounts());
    });

    // ADR 0033 — the one slot and everything waiting for it.
    app.get('/api/queue', async (_req, reply) => {
        return reply.send(await getQueue());
    });

    app.get('/api/counts/queue-by-agent', async (_req, reply) => {
        return reply.send(await countsService.getQueueDepthByAgent());
    });

    app.get('/api/counts/project/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        return reply.send(await countsService.getProjectCounts(id));
    });

    app.get('/api/dashboard', async (req, reply) => {
        const raw = (req.query as { tz?: string } | undefined)?.tz;
        const [kpis, awaiting, queue] = await Promise.all([
            countsService.getDashboardKpis(raw === undefined ? undefined : normalizeTz(raw)),
            countsService.getAwaitingItems(),
            countsService.getQueueItems(),
        ]);
        return reply.send({ kpis, awaiting, queue });
    });
}
