import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IApiClient, IAgentWritePayload } from '../api-client.js';
import {
    AgentCategorySchema,
    AgentChecklistItemInputSchema,
    AgentCliSchema,
    AgentEffortSchema,
    AgentKindSlugSchema,
    AgentStatusSchema,
    SdlcRoleSchema,
} from '@atlas/shared';
import type { ToolRegistration } from '../registrations.js';

function toToolResult(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
}

// Tool consolidation 2026-07: the agent + marketplace surface is THREE tools:
//   * crud_agent        — op: search | get | create | update | delete
//   * agent_memory      — op: get | update
//   * marketplace_agent — op: search | get

// Required-at-create fields are enforced by the API (CreateAgentSchema);
// `.strict()` turns a typo into a validation error instead of a silent drop.
const AgentWritablePayloadSchema = z
    .object({
        id: z.string().min(1).optional(),
        name: z.string().min(1).max(100).optional(),
        category: AgentCategorySchema.optional(),
        cli: AgentCliSchema.optional(),
        model: z.string().min(1).optional(),
        effort: AgentEffortSchema.optional(),
        framework: z.string().optional(),
        prompt_md: z.string().optional(),
        status: AgentStatusSchema.optional(),
        accent_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        sort_order: z.number().int().optional(),
        description: z.string().optional(),
        designation: z.string().max(100).optional(),
        role_id: SdlcRoleSchema.nullable().optional(),
        glyph: z.string().optional(),
        // Update only — CreateAgentSchema doesn't take it.
        memory_cadence: z.number().int().min(1).max(100).optional(),
        kind_slug: AgentKindSlugSchema.optional(),
        settings_json: z.record(z.string(), z.unknown()).optional(),
        checklists: z.array(AgentChecklistItemInputSchema).optional(),
    })
    .strict();

export const AGENT_TOOLS: ToolRegistration[] = [
    {
        name: 'crud_agent',
        title: 'Search, fetch, create, update, or delete an agent',
        description: [
            'Single entry point for the basic operations on agents.',
            '',
            'Branches on `op`:',
            "- `op: 'search'` → returns every agent as a compact row: id, name, category, cli, status, sort_order, prompt_version. Use it to find an agent id.",
            "- `op: 'get'` → `{ agent, checklists }` for one agent. Required: `id`.",
            "- `op: 'create'` → create an agent. Required: `payload` with `name`, `category`, `cli`, `model` (must be registered for that CLI), `accent_color` (#RRGGBB). Optional: `id` (a UUID is generated when omitted — pass a stable kebab-case id if you will refer to it), `effort` (default `medium`), `framework`, `prompt_md`, `status` (default `active`), `sort_order`, `description`, `designation`, `role_id`, `glyph`, `kind_slug`, `settings_json`, `checklists`. Returns `{ agent, checklists }`.",
            "- `op: 'update'` → patch an agent. Required: `id` + `payload` (any of the create fields except `id`, plus `memory_cadence` 1-100). Editing `prompt_md` bumps `prompt_version` and snapshots the old prompt. Passing `checklists` replaces them. Returns `{ agent, checklists }`.",
            "- `op: 'delete'` → permanently remove an agent. Required: `id`. Also deletes its prompt versions, checklists, memory, tests and agent runs; items, comments, activity events, Jira sources and notifications keep their rows with the agent reference cleared. Returns `{ deleted: true, id }`.",
            '',
            'Unknown `payload` keys are rejected. Agents carry no schedule, routing or git settings — the Task run owns those.',
            '',
            'The API does not check who is calling: the Owner uses create / update / delete from an MCP client such as Claude Desktop. Agents in a Task run are told by their prompt not to create, update or delete agents.',
        ].join('\n'),
        group_name: 'AGENTS',
        sort_order: 10,
        inputSchema: {
            op: z.enum(['search', 'get', 'create', 'update', 'delete']),
            id: z.string().min(1).optional(),
            payload: AgentWritablePayloadSchema.optional(),
        },
        handler: async (args, { client }) => {
            const { op, id, payload } = args as {
                op: 'search' | 'get' | 'create' | 'update' | 'delete';
                id?: string;
                payload?: IAgentWritePayload;
            };
            switch (op) {
                case 'search': {
                    const agents = await client.listAgents();
                    return toToolResult(
                        agents.map((a) => ({
                            id: a.id,
                            name: a.name,
                            category: a.category,
                            cli: a.cli,
                            status: a.status,
                            sort_order: a.sort_order,
                            prompt_version: a.prompt_version,
                        })),
                    );
                }
                case 'get':
                    if (!id) throw new Error("crud_agent: `id` is required for op='get'");
                    return toToolResult(await client.getAgent(id));
                case 'create':
                    if (!payload)
                        throw new Error("crud_agent: `payload` is required for op='create'");
                    return toToolResult(await client.createAgent(payload));
                case 'update':
                    if (!id || !payload)
                        throw new Error(
                            "crud_agent: `id` and `payload` are required for op='update'",
                        );
                    return toToolResult(await client.updateAgent(id, payload));
                case 'delete':
                    if (!id) throw new Error("crud_agent: `id` is required for op='delete'");
                    await client.deleteAgent(id);
                    return toToolResult({ deleted: true, id });
            }
        },
    },
    {
        name: 'agent_memory',
        title: "Read or write an agent's persistent memory",
        description: [
            "Single entry point for agent-memory CRUD. Memory is the agent's procedural notes — what it learned in prior runs that should persist across sessions.",
            '',
            'Branches on `op`:',
            "- `op: 'get'` → return the agent's memory row (`agent_id`, `body_md`, `version`, `source`, `last_run_id`, `updated_at`). Required: `id`. Use before authoring an edit so you don't clobber.",
            "- `op: 'update'` → write to memory. Required: `id`, `body_md`. Optional: `mode` (`'replace'` default vs `'append'`). Returns the memory row.",
            '',
            '**Memory boundary — what belongs here, what does not.** Memory is for *behavioral generalizations* of how YOU should approach future similar work — process, style, anti-patterns, escalation triggers. Memory is NOT for product or project facts. Test: "would this fact be just as true if a different item or different project hit this code path?" If yes → save. If it\'s tied to project X / item Y / a specific user → does NOT belong; put it in item comments or spec_md instead.',
            '',
            '**`mode`**:',
            "- `'replace'` (default) overwrites the whole body; the API bumps `version`.",
            "- `'append'` surgically appends a bullet under `## Course corrections`. Use this for one-off lessons captured mid-run. Append audits as `trigger='mcp_update'` and does NOT reset the cadence regenerator.",
        ].join('\n'),
        group_name: 'AGENTS',
        sort_order: 11,
        inputSchema: {
            op: z.enum(['get', 'update']),
            id: z.string().min(1),
            body_md: z.string().max(100_000).optional(),
            mode: z.enum(['replace', 'append']).optional(),
        },
        handler: async (args, { client }) => {
            const { op, id, body_md, mode } = args as {
                op: 'get' | 'update';
                id: string;
                body_md?: string;
                mode?: 'replace' | 'append';
            };
            if (op === 'get') {
                return toToolResult(await client.getAgentMemory(id));
            }
            if (body_md === undefined)
                throw new Error("agent_memory: `body_md` is required for op='update'");
            return toToolResult(
                await client.updateAgentMemory(id, { body_md, mode: mode ?? 'replace' }),
            );
        },
    },
    {
        name: 'marketplace_agent',
        title: 'Search or fetch from the agent marketplace catalog',
        description: [
            'Single entry point for browsing the marketplace catalog (installable / upgradable agents).',
            '',
            'Branches on `op`:',
            "- `op: 'search'` → returns a lightweight projection of catalog rows (id, name, category, kind_slug, summary, accent_color, glyph, version, installed/linked/upgrade-available flags). Optional filters: `query`, `category`, `kind_slug`, `limit` (1-100). Use this first to find a candidate id.",
            "- `op: 'get'` → fetch the full catalog entry for one marketplace agent: manifest + prompt_md + memory_template_md + checklists + version + published_at. Required: `id`. Chain after `op='search'`, before installing or applying its prompt to an existing agent via `crud_agent op='update'`.",
            '',
            "The `upgrade_available` flag on a search result is true when the local agent's `marketplace_pulled_version` is strictly less than the catalog version.",
        ].join('\n'),
        group_name: 'AGENTS',
        sort_order: 12,
        inputSchema: {
            op: z.enum(['search', 'get']),
            id: z.string().min(1).optional(),
            query: z.string().optional(),
            category: AgentCategorySchema.optional(),
            kind_slug: AgentKindSlugSchema.optional(),
            limit: z.number().int().min(1).max(100).optional(),
        },
        handler: async (args, { client }) => {
            const { op, id, ...filters } = args as {
                op: 'search' | 'get';
                id?: string;
            } & Parameters<IApiClient['searchMarketplaceAgents']>[0];
            if (op === 'search') return toToolResult(await client.searchMarketplaceAgents(filters));
            if (!id) throw new Error("marketplace_agent: `id` is required for op='get'");
            return toToolResult(await client.getMarketplaceAgent(id));
        },
    },
];

export function registerAgentTools(server: McpServer, client: IApiClient): void {
    for (const t of AGENT_TOOLS) {
        server.registerTool(
            t.name,
            { title: t.title, description: t.description, inputSchema: t.inputSchema },
            (args) => t.handler(args, { client }),
        );
    }
}
