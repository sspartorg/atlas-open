import type {
    AgentCategory,
    AgentKindSlug,
    IAgent,
    IAgentChecklistItem,
    IComment,
    IMarketplaceAgentFull,
    IMarketplaceAgentSummary,
    IProject,
    IProjectRepo,
    IReminder,
    ISubTask,
    ITask,
    IssuePriority,
    IssueStatus,
    IssueType,
    ReminderChannel,
    ReminderSchedule,
} from '@atlas/shared';
import type { IMcpConfig } from './config.js';

export class AtlasApiError extends Error {
    public override readonly name = 'AtlasApiError';
    constructor(
        public readonly status: number,
        public readonly url: string,
        public readonly bodySnippet: string
    ) {
        // Prefix 4xx messages with a parseable marker so the run-log viewer
        // can highlight them. Bare "API 400 on /api/...: ..." used to land
        // inside an MCP tool result and render as ordinary JSON, hiding what
        // were almost always validation regressions (missing agent_id,
        // wrong issue_type, etc.) inside long transcripts.
        const marker = status >= 400 && status < 500 ? `[atlas-api-${status}] ` : '';
        super(`${marker}Atlas API ${status} on ${url}: ${bodySnippet}`);
    }
}

/**
 * Composite agent payload returned by getAgent / createAgent / updateAgent.
 * Bundles the core record plus its child collections so a single MCP tool
 * call is enough for Claude to see the full agent.
 */
export interface IAgentComposite {
    agent: IAgent;
    checklists: IAgentChecklistItem[];
}

/**
 * Write payload for POST /api/agents (CreateAgentSchema) and PATCH
 * /api/agents/:id (UpdateAgentSchema). `undefined` means "do not touch"; a
 * present (possibly empty) `checklists` array replaces the collection.
 */
export interface IAgentWritePayload {
    id?: string | undefined;
    name?: string | undefined;
    category?: IAgent['category'] | undefined;
    cli?: IAgent['cli'] | undefined;
    model?: string | undefined;
    effort?: IAgent['effort'] | undefined;
    framework?: string | undefined;
    prompt_md?: string | undefined;
    status?: IAgent['status'] | undefined;
    accent_color?: string | undefined;
    sort_order?: number | undefined;
    description?: string | undefined;
    designation?: string | undefined;
    role_id?: IAgent['role_id'] | undefined;
    glyph?: string | undefined;
    memory_cadence?: number | undefined;
    kind_slug?: AgentKindSlug | undefined;
    settings_json?: Record<string, unknown> | undefined;
    checklists?: Array<{ label: string; sort_order?: number | undefined; required?: boolean | undefined }> | undefined;
}

// Create-item payloads — the subset of CreateTaskSchema / CreateSubTaskSchema
// the MCP exposes (no assignee: agents never route work). Optional fields
// default server-side. `field?: T | undefined` because of
// `exactOptionalPropertyTypes` + Zod's `.optional()`.
interface ICreateTaskPayload {
    project_id: string;
    title: string;
    description?: string | undefined;
    acceptance_criteria?: string | undefined;
    priority?: IssuePriority | undefined;
    reporter_agent_id?: string | null | undefined;
    labels?: string[] | undefined;
    repo_ids?: string[] | undefined;
}

interface ICreateSubTaskPayload {
    task_id: string;
    title: string;
    description?: string | undefined;
    acceptance_criteria?: string | undefined;
    priority?: IssuePriority | undefined;
    status?: IssueStatus | undefined;
    reporter_agent_id?: string | null | undefined;
    labels?: string[] | undefined;
}

// Always posted with `author: 'agent'`. `agent_id` is self-declared by the
// caller (there is no bound identity); when null, `commentsService.create`
// attributes the comment to the item's live run, if any.
interface IAddCommentPayload {
    issue_type: IssueType;
    issue_id: string;
    body: string;
    agent_id: string | null;
}

// Mirrors SetReminderSchema in shared.
interface ISetReminderPayload {
    label: string;
    body?: string | undefined;
    schedule: ReminderSchedule;
    channel?: ReminderChannel | undefined;
    created_by_agent_id?: string | null | undefined;
}

interface IUpdateReminderPayload {
    label?: string | undefined;
    body?: string | undefined;
    schedule?: ReminderSchedule | undefined;
    channel?: ReminderChannel | undefined;
    status?: 'active' | 'paused' | undefined;
}

interface IAgentMemory {
    agent_id: string;
    body_md: string;
    version: number;
    source: 'ai-generated' | 'manual-edit';
    last_run_id: string | null;
    updated_at: string;
}

// Mirrors AgentMemoryUpdateSchema: `'replace'` overwrites the body,
// `'append'` adds a bullet under `## Course corrections`.
interface IUpdateAgentMemoryPayload {
    body_md: string;
    mode: 'replace' | 'append';
}

// The REST surface keys on the FROM item's (type, id) pair:
// POST /api/issues/:type/:id/links and DELETE /api/issues/links/:linkId.
interface ICreateItemLinkPayload {
    from_type: IssueType;
    from_id: string;
    to_id: string;
    relation_type: 'relates_to' | 'depends_on' | 'tested_by';
}

/** GET /api/search row. */
interface ISearchHit {
    issue_type: IssueType;
    issue_id: string;
    title: string;
    description: string;
    status: IssueStatus;
    project_id: string;
    assignee_agent_id: string | null;
    updated_at: string;
    rank: number;
}

/** POST /api/notifications/send-external. `held` = quiet hours; it sends when the window ends. */
interface ISendExternalResult {
    ok: true;
    sent: boolean;
    held: boolean;
    notification_id: number;
    external_status: 'none' | 'pending' | 'sent' | 'failed';
}

export interface IApiClient {
    listAgents(): Promise<IAgent[]>;
    getAgent(id: string): Promise<IAgentComposite>;
    createAgent(payload: IAgentWritePayload): Promise<IAgentComposite>;
    updateAgent(id: string, payload: IAgentWritePayload): Promise<IAgentComposite>;
    deleteAgent(id: string): Promise<void>;
    getAgentMemory(id: string): Promise<IAgentMemory>;
    updateAgentMemory(id: string, payload: IUpdateAgentMemoryPayload): Promise<IAgentMemory>;
    // Marketplace catalog, backing the `marketplace_agent` tool.
    searchMarketplaceAgents(query: {
        query?: string;
        category?: AgentCategory;
        kind_slug?: AgentKindSlug;
        limit?: number;
    }): Promise<IMarketplaceAgentSummary[]>;
    getMarketplaceAgent(id: string): Promise<IMarketplaceAgentFull>;
    getItemFull(issueType: IssueType, issueId: string): Promise<unknown>;
    searchItems(query: string, limit: number): Promise<ISearchHit[]>;
    // `actorAgentId` on item writes is forwarded as the `x-atlas-agent-id`
    // header (or `requested_by_agent_id` on status changes) so the API
    // credits the activity event to that agent instead of the Owner.
    createTask(payload: ICreateTaskPayload, actorAgentId: string | null): Promise<ITask>;
    createSubTask(payload: ICreateSubTaskPayload, actorAgentId: string | null): Promise<ISubTask>;
    addComment(payload: IAddCommentPayload): Promise<IComment>;
    listProjects(): Promise<IProject[]>;
    getProject(id: string): Promise<IProject & { repos: IProjectRepo[] }>;
    createItemLink(payload: ICreateItemLinkPayload, actorAgentId: string | null): Promise<unknown>;
    deleteItemLink(linkId: number, actorAgentId: string | null): Promise<void>;
    // POST /api/issues/:type/:id/history/prune — the `remove_history` action.
    pruneItemHistory(
        issueType: IssueType,
        id: string,
        beforeTime: string,
        actorAgentId: string | null,
    ): Promise<{ comments_deleted: number; events_deleted: number; owner_comments_preserved: number }>;
    setReminder(payload: ISetReminderPayload): Promise<IReminder>;
    updateReminder(id: number, payload: IUpdateReminderPayload): Promise<IReminder>;
    cancelReminder(id: number): Promise<IReminder>;
    snoozeReminder(id: number, minutes: number): Promise<IReminder>;
    listReminders(filter?: {
        status?: 'active' | 'paused' | 'cancelled' | 'completed';
        channel?: ReminderChannel;
        since?: string;
    }): Promise<IReminder[]>;
    sendExternalNotification(payload: { message: string; event_key?: string }): Promise<ISendExternalResult>;
    // The per-type Update*Schema on the route decides which fields are
    // accepted, so a field that doesn't apply gets a 400 with the Zod error.
    updateItem(
        issueType: IssueType,
        id: string,
        patch: Record<string, unknown>,
        actorAgentId: string | null,
    ): Promise<unknown>;
    transitionItemStatus(
        issueType: IssueType,
        id: string,
        status: string,
        requestedByAgentId: string | null,
    ): Promise<unknown>;
    deleteItem(issueType: IssueType, id: string): Promise<void>;
    // No git or PR surface: agents never commit or push. The Task run
    // commits, pushes and opens the PR (`services/workflow-engine.ts`).
}

export function createApiClient(config: IMcpConfig): IApiClient {
    const buildUrl = (path: string) => config.apiBase + path;

    const request = async <T>(
        path: string,
        init?: { method?: string; body?: unknown; headers?: Record<string, string> }
    ): Promise<T> => {
        const url = buildUrl(path);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
        const isWrite = init?.method && init.method !== 'GET';
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
        if (isWrite && config.mcpToken) headers['X-Atlas-Token'] = config.mcpToken;
        // Caller-supplied headers (`x-atlas-agent-id`) layer over the defaults.
        if (init?.headers) Object.assign(headers, init.headers);
        try {
            const fetchInit: RequestInit = {
                method: init?.method ?? 'GET',
                headers,
                signal: controller.signal,
            };
            if (init?.body !== undefined) {
                fetchInit.body = JSON.stringify(init.body);
            }
            const res = await fetch(url, fetchInit);
            if (!res.ok) {
                const snippet = (await res.text().catch(() => '')).slice(0, 200);
                throw new AtlasApiError(res.status, url, snippet);
            }
            // Some endpoints return 204; tolerate empty bodies.
            const text = await res.text();
            return (text ? JSON.parse(text) : undefined) as T;
        } finally {
            clearTimeout(timeout);
        }
    };

    const agentHeader = (actorAgentId: string | null) =>
        actorAgentId ? { headers: { 'x-atlas-agent-id': actorAgentId } } : {};

    const fetchComposite = async (id: string): Promise<IAgentComposite> => {
        const encoded = encodeURIComponent(id);
        const [agent, checklists] = await Promise.all([
            request<IAgent>(`/api/agents/${encoded}`),
            request<IAgentChecklistItem[]>(`/api/agents/${encoded}/checklists`),
        ]);
        return { agent, checklists };
    };

    const listRepos = (projectId: string) =>
        request<IProjectRepo[]>(`/api/projects/${encodeURIComponent(projectId)}/repos`);

    return {
        listAgents: () => request<IAgent[]>('/api/agents'),
        getAgent: (id) => fetchComposite(id),
        searchMarketplaceAgents: (query) => {
            const params = new URLSearchParams();
            if (query.query) params.set('q', query.query);
            if (query.category) params.set('category', query.category);
            if (query.kind_slug) params.set('kind', query.kind_slug);
            if (query.limit != null) params.set('limit', String(query.limit));
            const qs = params.toString();
            return request<IMarketplaceAgentSummary[]>(
                `/api/marketplace/agents${qs ? `?${qs}` : ''}`,
            );
        },
        getMarketplaceAgent: (id) =>
            request<IMarketplaceAgentFull>(`/api/marketplace/agents/${encodeURIComponent(id)}`),
        createAgent: async (payload) => {
            const created = await request<IAgent>('/api/agents', {
                method: 'POST',
                body: payload,
            });
            return fetchComposite(created.id);
        },
        updateAgent: async (id, payload) => {
            await request<IAgent>(`/api/agents/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: payload,
            });
            return fetchComposite(id);
        },
        createTask: (payload, actorAgentId) =>
            request<ITask>('/api/tasks', { method: 'POST', body: payload, ...agentHeader(actorAgentId) }),
        // Sub-tasks are created under their task: POST /api/tasks/:id/sub-tasks.
        createSubTask: (payload, actorAgentId) => {
            const { task_id, ...rest } = payload;
            return request<ISubTask>(
                `/api/tasks/${encodeURIComponent(task_id)}/sub-tasks`,
                { method: 'POST', body: rest, ...agentHeader(actorAgentId) },
            );
        },
        addComment: (payload) =>
            request<IComment>('/api/comments', {
                method: 'POST',
                body: {
                    author: 'agent',
                    agent_id: payload.agent_id,
                    issue_type: payload.issue_type,
                    issue_id: payload.issue_id,
                    body: payload.body,
                },
            }),

        deleteAgent: async (id) => {
            await request<void>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
        getAgentMemory: (id) =>
            request<IAgentMemory>(`/api/agents/${encodeURIComponent(id)}/memory`),
        updateAgentMemory: (id, payload) =>
            request<IAgentMemory>(`/api/agents/${encodeURIComponent(id)}/memory`, {
                method: 'PUT',
                body: payload,
            }),

        // `get_item` envelope. `/api/{type}/{id}/full` returns the item +
        // parent/children + project + related_links + external_links +
        // activity + agents; the comment thread and the project's repos come
        // from their own routes and are spliced in so one tool call is enough.
        getItemFull: async (issueType, issueId) => {
            const seg = issueTypeToRouteSegment(issueType);
            const [full, comments] = await Promise.all([
                request<Record<string, unknown> & { project?: { id: string } | null }>(
                    `/api/${seg}/${encodeURIComponent(issueId)}/full`,
                ),
                request<IComment[]>(
                    `/api/comments?issue_type=${encodeURIComponent(issueType)}&issue_id=${encodeURIComponent(issueId)}`,
                ),
            ]);
            const repos = full.project ? await listRepos(full.project.id) : [];
            return { ...full, repos, comments };
        },

        // GET /api/search reads `limit` (default 50, max 200).
        searchItems: (query, limit) => {
            const params = new URLSearchParams({ q: query, limit: String(limit) });
            return request<ISearchHit[]>(`/api/search?${params.toString()}`);
        },

        listProjects: () => request<IProject[]>('/api/projects'),
        getProject: async (id) => {
            const [project, repos] = await Promise.all([
                request<IProject>(`/api/projects/${encodeURIComponent(id)}`),
                listRepos(id),
            ]);
            return { ...project, repos };
        },

        createItemLink: (payload, actorAgentId) =>
            request<unknown>(
                `/api/issues/${encodeURIComponent(payload.from_type)}/${encodeURIComponent(payload.from_id)}/links`,
                {
                    method: 'POST',
                    body: {
                        // CreateIssueLinkSchema requires `to_type`, but the
                        // route resolves the target from `to_id` alone and
                        // never reads it, so any valid type works.
                        to_type: payload.from_type,
                        to_id: payload.to_id,
                        relation_type: payload.relation_type,
                    },
                    ...agentHeader(actorAgentId),
                },
            ),
        deleteItemLink: async (linkId, actorAgentId) => {
            await request<void>(`/api/issues/links/${linkId}`, {
                method: 'DELETE',
                ...agentHeader(actorAgentId),
            });
        },

        pruneItemHistory: (issueType, id, beforeTime, actorAgentId) =>
            request<{ comments_deleted: number; events_deleted: number; owner_comments_preserved: number }>(
                `/api/issues/${encodeURIComponent(issueType)}/${encodeURIComponent(id)}/history/prune`,
                {
                    method: 'POST',
                    body: { before_time: beforeTime },
                    // No header → the `history_pruned` event has a null actor.
                    ...agentHeader(actorAgentId),
                },
            ),

        setReminder: (payload) =>
            request<IReminder>('/api/reminders', { method: 'POST', body: payload }),
        updateReminder: (id, payload) =>
            request<IReminder>(`/api/reminders/${id}`, { method: 'PATCH', body: payload }),
        cancelReminder: (id) =>
            request<IReminder>(`/api/reminders/${id}`, { method: 'DELETE' }),
        snoozeReminder: (id, minutes) =>
            request<IReminder>(`/api/reminders/${id}/snooze`, { method: 'POST', body: { minutes } }),
        listReminders: (filter) => {
            const params = new URLSearchParams();
            if (filter?.status) params.set('status', filter.status);
            if (filter?.channel) params.set('channel', filter.channel);
            if (filter?.since) params.set('since', filter.since);
            const qs = params.toString();
            return request<IReminder[]>(`/api/reminders${qs ? `?${qs}` : ''}`);
        },

        // The API logs it as a log-only notification row (held through quiet hours).
        sendExternalNotification: (payload) =>
            request<ISendExternalResult>('/api/notifications/send-external', { method: 'POST', body: payload }),

        updateItem: (issueType, id, patch, actorAgentId) => {
            const seg = issueTypeToRouteSegment(issueType);
            return request<unknown>(`/api/${seg}/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: patch,
                ...agentHeader(actorAgentId),
            });
        },
        // Never `?override=1`: overriding the status machine is the Owner's
        // escape hatch in the web UI only.
        transitionItemStatus: (issueType, id, status, requestedByAgentId) => {
            const seg = issueTypeToRouteSegment(issueType);
            const body: Record<string, unknown> = { status };
            if (requestedByAgentId) body['requested_by_agent_id'] = requestedByAgentId;
            return request<unknown>(`/api/${seg}/${encodeURIComponent(id)}/status`, {
                method: 'PATCH',
                body,
            });
        },
        deleteItem: async (issueType, id) => {
            const seg = issueTypeToRouteSegment(issueType);
            await request<void>(`/api/${seg}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
    };
}

// Map IssueType discriminator → REST route segment. Each kind has its own
// /api/{segment}/:id/* surface.
function issueTypeToRouteSegment(t: IssueType): string {
    return t === 'task' ? 'tasks' : 'sub-tasks';
}
