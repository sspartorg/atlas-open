import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IQueue, IQueueEntry } from '@atlas/shared';
import { api } from '../api/api.js';

// SSE invalidates ['queue'] on run_queued / agent_status / run_completed /
// counts_changed / workflow_run_updated (useSSE.ts).
export function useQueue() {
    return useQuery<IQueue>({ queryKey: ['queue'], queryFn: () => api.queue.get() });
}

/** Stops a running entry, or cancels a waiting agent run (same endpoint: it is still a queued run row). */
export function useStopQueueEntry() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (entry: Pick<IQueueEntry, 'kind' | 'run_id'>) => {
            if (!entry.run_id) return;
            if (entry.kind === 'task') await api.workflowRuns.stop(entry.run_id);
            else await api.run.stop(entry.run_id);
        },
        onSettled: () => {
            void qc.invalidateQueries({ queryKey: ['queue'] });
        },
    });
}
