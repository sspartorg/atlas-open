import type { FastifyInstance } from 'fastify';
import { AnalyticsQuerySchema } from '@atlas/shared';
import { analytics } from '../services/analytics.js';

// Cost data changes only when a run completes, which fires an SSE event that
// invalidates the React Query cache on the client. A 30s freshness window with
// stale-while-revalidate keeps the page feeling instant without serving lies.
const ANALYTICS_CACHE_CONTROL = 'private, max-age=30, stale-while-revalidate=120';

export async function analyticsRoutes(app: FastifyInstance) {
    app.get('/api/analytics', async (req, reply) => {
        reply.header('Cache-Control', ANALYTICS_CACHE_CONTROL);
        return reply.send(await analytics(AnalyticsQuerySchema.parse(req.query ?? {})));
    });
}
