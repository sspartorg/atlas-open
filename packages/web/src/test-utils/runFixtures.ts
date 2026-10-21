import type { IWorkflowRunDetail, IWorkflowRunStep } from '@atlas/shared';

const ISO = '2026-09-14T10:00:00.000Z';

export function makeRunStep(overrides: Partial<IWorkflowRunStep> = {}): IWorkflowRunStep {
    return {
        id: 'run-a',
        node_id: 'coder',
        agent_id: 'agent-coder',
        agent_name: 'Coder',
        status: 'completed',
        cli: 'claude',
        model: 'claude-opus-4-7',
        effort: 'medium',
        outcome_kind: 'done',
        outcome_summary: 'Implemented the change',
        outcome_reason: null,
        total_cost_usd: 0.42,
        started_at: ISO,
        completed_at: '2026-09-14T10:05:00.000Z',
        ...overrides,
    };
}

export function makeRunDetail(overrides: Partial<IWorkflowRunDetail> = {}): IWorkflowRunDetail {
    return {
        id: 'wfr-1',
        workflow_id: 'task-run',
        item_id: 'ATL-7',
        project_id: 'p1',
        status: 'running',
        graph_snapshot: {
            nodes: [
                { id: 'start', type: 'start', position: { x: 0, y: 0 } },
                { id: 'coder', type: 'agent', agent_id: 'agent-coder', position: { x: 0, y: 130 } },
                { id: 'end', type: 'end', position: { x: 0, y: 260 } },
            ],
            edges: [
                { id: 'e1', source: 'start', target: 'coder', kind: 'pass' },
                { id: 'e2', source: 'coder', target: 'end', kind: 'pass' },
            ],
        },
        current_node_id: 'coder',
        parked_node_id: null,
        park_reason: null,
        branch: 'atlas/ATL-7',
        worktree_path: null,
        setup_done: true,
        pr_url: null,
        pr_urls: [],
        started_at: ISO,
        updated_at: ISO,
        finished_at: null,
        item_title: 'Add login',
        total_cost_usd: 0.42,
        steps: [makeRunStep()],
        ...overrides,
    };
}
