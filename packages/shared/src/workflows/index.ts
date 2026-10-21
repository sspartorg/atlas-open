import type { AgentCli, AgentEffort, RunOutcomeKind, RunStatus } from '../types/index.js';

// atlas-open: a Task run is its assigned agent, then delivery. The run record
// keeps the graph shape (start → agent → end) it was frozen with.
export const WORKFLOW_NODE_TYPES = ['start', 'agent', 'end'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_EDGE_KINDS = ['pass', 'fail'] as const;
export type WorkflowEdgeKind = (typeof WORKFLOW_EDGE_KINDS)[number];

export const WORKFLOW_RUN_STATUSES = ['running', 'waiting_for_owner', 'completed', 'cancelled', 'error'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface IWorkflowNode {
    id: string;
    type: WorkflowNodeType;
    agent_id?: string | undefined;
    position: { x: number; y: number };
}

export interface IWorkflowEdge {
    id: string;
    source: string;
    target: string;
    kind: WorkflowEdgeKind;
}

export interface IWorkflowGraph {
    nodes: IWorkflowNode[];
    edges: IWorkflowEdge[];
}

export interface IWorkflowRun {
    id: string;
    workflow_id: string;
    item_id: string | null;
    project_id: string | null;
    status: WorkflowRunStatus;
    graph_snapshot: IWorkflowGraph;
    current_node_id: string | null;
    parked_node_id: string | null;
    /** Why the run is waiting for the Owner; null unless `waiting_for_owner`. */
    park_reason: string | null;
    branch: string | null;
    worktree_path: string | null;
    setup_done: boolean;
    /** The FIRST pull request this run opened. Agents read this one. */
    pr_url: string | null;
    /**
     * ADR 0017/0018 — every PR the run opened, in repo order, `pr_url` first.
     * A multi-repo Task opens one per repo it changed; this is the complete
     * set. Empty when the run opened none.
     */
    pr_urls: string[];
    started_at: string;
    updated_at: string;
    finished_at: string | null;
}

/** A list row: the run plus the title of the item it worked on. */
export interface IWorkflowRunSummary extends IWorkflowRun {
    item_title: string | null;
}

/** One agent step inside a Task run — an `agent_runs` row projected for the run view. */
export interface IWorkflowRunStep {
    id: string;
    node_id: string | null;
    agent_id: string;
    agent_name: string | null;
    status: RunStatus;
    cli: AgentCli | null;
    model: string | null;
    effort: AgentEffort | null;
    outcome_kind: RunOutcomeKind | null;
    outcome_summary: string | null;
    outcome_reason: string | null;
    total_cost_usd: number | null;
    started_at: string | null;
    completed_at: string | null;
}

export interface IWorkflowRunDetail extends IWorkflowRunSummary {
    steps: IWorkflowRunStep[];
    total_cost_usd: number;
}

/**
 * What resolving a workflow's agent dependencies actually did.
 *
 * Every agent a resolution touches lands in exactly one of these buckets.
 */
export interface IAgentDependencyReport {
    /** Not present before; installed from the catalog. */
    installed: string[];
    /** Back-linked, behind the catalog, and unedited — brought up to date. */
    upgraded: string[];
    /**
     * Behind the catalog but carrying Owner edits, so left exactly as they are.
     * The upgrade is still offered in the marketplace UI; nothing was lost.
     */
    skipped_edited: string[];
    /** Already current, or not back-linked to a catalog entry. */
    unchanged: string[];
    /**
     * Already here and NOT active. Resolution leaves their status alone — a
     * pause is a decision the Owner made — so the run would park on them. They
     * are reported rather than silently re-activated, which is what used to
     * happen. Agents installed by this same resolution are not here: they are
     * activated on the way in, because nobody paused them.
     */
    paused: string[];
}
