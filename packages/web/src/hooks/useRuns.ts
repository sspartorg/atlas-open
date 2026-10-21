import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliSessionDiffScopeName } from '@atlas/shared';
import { api } from '../api/api.js';

// A Task's runs: its assigned agent working it end to end. The API keeps the
// `workflow-runs` paths, so the query keys do too.

export function useWorkflowRun(runId: string) {
    return useQuery({
        queryKey: ['workflow-run', runId],
        queryFn: () => api.workflowRuns.get(runId),
        enabled: Boolean(runId),
    });
}

export function useWorkflowRunDiff(runId: string, enabled = true) {
    return useQuery({
        queryKey: ['workflow-run-diff', runId],
        queryFn: () => api.workflowRuns.diff(runId),
        enabled: enabled && Boolean(runId),
        retry: false,
    });
}

export function useWorkflowRunFilePatch(
    runId: string,
    repoId: string,
    scope: CliSessionDiffScopeName,
    path: string | null,
    context: number,
    enabled: boolean,
) {
    return useQuery({
        queryKey: ['workflow-run-diff-patch', runId, repoId, scope, path, context],
        queryFn: () => api.workflowRuns.diffFile(runId, { repoId, scope, path: path as string, context }),
        enabled: enabled && Boolean(runId) && Boolean(path),
        retry: false,
    });
}

export function useItemWorkflowRuns(itemId: string) {
    return useQuery({
        queryKey: ['item-workflow-runs', itemId],
        queryFn: () => api.workflowRuns.forItem(itemId),
        enabled: Boolean(itemId),
    });
}

function useRunAction(action: (id: string) => ReturnType<typeof api.workflowRuns.stop>) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: action,
        onSuccess: (run) => {
            qc.setQueryData(['workflow-run', run.id], run);
            if (run.item_id) {
                void qc.invalidateQueries({ queryKey: ['item-workflow-runs', run.item_id] });
            }
        },
    });
}

export function useStopWorkflowRun() {
    return useRunAction((id) => api.workflowRuns.stop(id));
}

export function useResumeWorkflowRun() {
    return useRunAction((id) => api.workflowRuns.resume(id));
}
