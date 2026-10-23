import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IApiClient } from '../api-client.js';
import {
    IssuePrioritySchema,
    IssueStatusSchema,
    IssueTypeSchema,
    ItemLabelsOptionalSchema,
} from '@atlas/shared';
import type { IssueType } from '@atlas/shared';
import type { ToolRegistration } from '../registrations.js';

function toToolResult(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
}

// Identity is self-declared: the optional `agent_id` tool argument, forwarded
// as `x-atlas-agent-id` (or `requested_by_agent_id` / the comment's
// `agent_id`). There is no bound identity — the API's in-process MCP host
// (packages/api/src/plugins/mcp-host.ts) serves every agent on one port, and
// nothing sets a per-agent env var. The API drops ids that aren't real agents,
// and `commentsService.create` attributes an id-less agent comment to the
// item's live run.

// Tool consolidation 2026-07: the 17-tool items surface collapsed into FIVE:
//   * search_item  — full-text search
//   * create_item  — issue_type discriminator (task / sub_task)
//   * get_item     — full envelope (item + parent/children + project + repos + comments + links + activity)
//   * update_item  — `action` discriminator
//   * delete_item  — issue_type + id
// Agents never route work or record PRs (no assign, no external links, no
// pr_url / worktree_branch, no assignee at create): the Task run owns those.

const RelationTypeSchema = z.enum(['relates_to', 'depends_on', 'tested_by']);

// `.strict()` at the MCP boundary surfaces typos as validation errors instead
// of forwarding them for the API to reject (or strip).
const CommonCreateFields = {
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    priority: IssuePrioritySchema.optional(),
    reporter_agent_id: z.string().nullable().optional(),
    labels: ItemLabelsOptionalSchema,
};

const CreateTaskPayloadSchema = z
    .object({
        project_id: z.string().min(1),
        ...CommonCreateFields,
        repo_ids: z.array(z.string().min(1)).max(20).optional(),
    })
    .strict();

const CreateSubTaskPayloadSchema = z
    .object({
        task_id: z.string().min(1),
        ...CommonCreateFields,
        status: IssueStatusSchema.optional(),
    })
    .strict();

const CREATE_PAYLOAD_SCHEMAS = {
    task: CreateTaskPayloadSchema,
    sub_task: CreateSubTaskPayloadSchema,
} as const;

const UpdatePatchSchema = z
    .object({
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        priority: IssuePrioritySchema.optional(),
        acceptance_criteria: z.string().optional(),
        // Task-only (UpdateTaskSchema); the sub-task route rejects them.
        spec_md: z.string().nullable().optional(),
        reporter_agent_id: z.string().nullable().optional(),
        // Full replacement, matching the API.
        labels: ItemLabelsOptionalSchema,
    })
    .strict();

type UpdateAction =
    | 'patch_fields'
    | 'change_status'
    | 'add_comment'
    | 'add_link'
    | 'remove_link'
    | 'remove_history';

export const ITEM_TOOLS: ToolRegistration[] = [
    {
        name: 'search_item',
        title: 'Full-text search across items',
        description: [
            'Postgres full-text search over item titles and descriptions (tasks and sub-tasks; spec_md and comments are not searched). Title matches rank above description matches.',
            '',
            'Returns up to `top_k` items, best match first, as `[{issue_type, issue_id, title, description, status, project_id, assignee_agent_id, updated_at, rank}]`. A `query` shorter than 2 characters (after trimming) returns `[]`.',
            '',
            'Parameters:',
            '- `query` (required): keyword(s) to search for.',
            '- `top_k` (optional, 1-20, default 10): how many results to return.',
        ].join('\n'),
        group_name: 'ITEMS',
        sort_order: 20,
        inputSchema: {
            query: z.string().min(1),
            top_k: z.number().int().min(1).max(20).optional(),
        },
        handler: async (args, { client }) => {
            const { query, top_k } = args as { query: string; top_k?: number };
            return toToolResult(await client.searchItems(query, top_k ?? 10));
        },
    },
    {
        name: 'create_item',
        title: 'Create an item (task / sub_task)',
        description: [
            'Create a new item. `issue_type` selects the kind, and `payload` must be that kind\'s shape (unknown keys are rejected):',
            '',
            "- `issue_type: 'task'` → `payload`: `project_id` + `title` required. Optional: `description`, `acceptance_criteria`, `priority` (default `normal`), `reporter_agent_id`, `labels`, `repo_ids` (ids of the project's repos the Task works on, from `getProject` → `repos[].id`; may be omitted when the project has exactly one repo, otherwise the API rejects the create). The Task is created `draft` and unassigned — only the Owner assigns it, which queues it.",
            "- `issue_type: 'sub_task'` → `payload`: `task_id` (the parent Task) + `title` required. Optional: `description`, `acceptance_criteria`, `priority` (default `normal`), `reporter_agent_id`, `labels`, `status` (default `draft`).",
            '',
            '`labels`: array of strings, up to 20 labels / 40 chars each — e.g. `["backend", "qa"]`.',
            '',
            'Optional top-level `agent_id` (your own agent id): credits the `created` activity event to you and defaults `reporter_agent_id` to you when the payload does not set it. Without it the create is recorded as the Owner.',
            '',
            'Returns the created task or sub-task row.',
        ].join('\n'),
        group_name: 'ITEMS',
        sort_order: 21,
        inputSchema: {
            issue_type: IssueTypeSchema,
            // The SDK needs an object at the top level, so the per-kind union
            // lives on `payload`; the handler checks it matches `issue_type`.
            payload: z.union([CreateTaskPayloadSchema, CreateSubTaskPayloadSchema]),
            agent_id: z.string().min(1).optional(),
        },
        handler: async (args, { client }) => {
            const { issue_type, payload, agent_id } = args as {
                issue_type: IssueType;
                payload: unknown;
                agent_id?: string;
            };
            const parsed = CREATE_PAYLOAD_SCHEMAS[issue_type].safeParse(payload);
            if (!parsed.success) {
                const needs = issue_type === 'task' ? '`project_id`' : '`task_id`';
                throw new Error(
                    `create_item: payload is not a valid ${issue_type} payload (it needs ${needs} + \`title\`): ${parsed.error.message}`,
                );
            }
            const actor = agent_id ?? null;
            return toToolResult(
                issue_type === 'task'
                    ? await client.createTask(parsed.data as z.infer<typeof CreateTaskPayloadSchema>, actor)
                    : await client.createSubTask(parsed.data as z.infer<typeof CreateSubTaskPayloadSchema>, actor),
            );
        },
    },
    {
        name: 'get_item',
        title: 'Read an item with its full context',
        description: [
            'Fetch everything about one item in one call. Returns an object with:',
            '',
            '- the item under its kind key: `task` or `sub_task` (title, description, status, priority, assignee_agent_id, labels, …; a task also carries spec_md, repo_ids, worktree_branch, pr_url)',
            '- on a sub-task, `task` is its parent Task; on a task, `sub_tasks` lists its sub-tasks in run order',
            '- `project` — id, name, issue_key_prefix, description, status, guardrails_md, team_managed, jira_status_map, created_at, updated_at, last_activity_at',
            "- `repos` — the project's git repos (id, name, git_url, git_path, default_branch, clone_status, …); none is primary",
            '- `comments` — the full thread, oldest first',
            '- `related_links` — every depends_on / relates_to / tested_by link touching this item, both directions (`id` is what `remove_link` takes)',
            '- `external_links` — off-platform refs Atlas recorded (pull requests the Task run opened, Jira issues)',
            '- `activity` — recent activity events (status_changed, assigned, comment_added, …)',
            '- `agents` — every agent (prompt_md blanked), for resolving ids to names',
            '',
            'Required: `issue_type` (task / sub_task) + `id`.',
        ].join('\n'),
        group_name: 'ITEMS',
        sort_order: 22,
        inputSchema: {
            issue_type: IssueTypeSchema,
            id: z.string().min(1),
        },
        handler: async (args, { client }) => {
            const { issue_type, id } = args as { issue_type: IssueType; id: string };
            return toToolResult(await client.getItemFull(issue_type, id));
        },
    },
    {
        name: 'update_item',
        title: 'Update an item (fields, status, comments, links, history)',
        description: [
            'Single entry point for writes on an existing item. Required: `issue_type` (task / sub_task), `id`, `action`. Other fields depend on the action. Optional `agent_id` (your own agent id) credits the write to you in the activity log; without it the write is recorded as the Owner.',
            '',
            "- `action: 'patch_fields'` → `patch` (required) accepts `title`, `description`, `priority`, `acceptance_criteria`, `labels` (full replacement — to append, get_item → merge → send the full array). Task-only: `spec_md`, `reporter_agent_id` (the sub-task route rejects them). Returns the updated item.",
            '',
            "- `action: 'change_status'` → `status` (required) — one of draft, ready, in_progress, waiting_for_info, in_review, done. Only legal status-machine moves are accepted; a Task can't go `done` while any of its sub-tasks isn't done. While a Task run is working a Task, the API refuses that Task's status change with 409 — the agent running a Task reports through its `atlas-outcome` block instead. Returns the updated item.",
            '',
            "- `action: 'add_comment'` → `body` (required). Always posted as an agent comment; `agent_id` sets its author chip (without it, the agent of the run currently working the item, if any). Returns the comment.",
            '',
            "- `action: 'add_link'` → `to_id` (the other item's id) + `relation_type` ('depends_on' | 'relates_to' | 'tested_by') required. This item is the `from` side. `depends_on` is directed (cycles rejected); `relates_to` is undirected; `tested_by` is directed (from = the QA item). Self-links are rejected. Returns the link row.",
            '',
            "- `action: 'remove_link'` → `link_id` (required) — the `id` from `get_item` → `related_links[]`, as returned (a numeric string) or as a number. Returns `{ deleted: true, link_id }`.",
            '',
            "- `action: 'remove_history'` → `before_time` (required, ISO 8601 with offset, at least 1 hour in the past). Hard-deletes every agent-authored comment and every activity event on this item created strictly before it; Owner comments are always kept. Writes a `history_pruned` audit event. Returns `{ comments_deleted, events_deleted, owner_comments_preserved }`. Destructive and not recoverable — for pruning long-lived tracking items an automation agent comments on repeatedly.",
            '',
            'Assigning, linking pull requests and setting branches are not available here: the Owner assigns, and the Task run records its branch and PR.',
        ].join('\n'),
        group_name: 'ITEMS',
        sort_order: 23,
        inputSchema: {
            issue_type: IssueTypeSchema,
            id: z.string().min(1),
            action: z.enum([
                'patch_fields',
                'change_status',
                'add_comment',
                'add_link',
                'remove_link',
                'remove_history',
            ]),
            agent_id: z.string().min(1).optional(),
            patch: UpdatePatchSchema.optional(),
            status: IssueStatusSchema.optional(),
            body: z.string().min(1).optional(),
            to_id: z.string().min(1).optional(),
            relation_type: RelationTypeSchema.optional(),
            // Postgres bigint ids come back from get_item as strings.
            link_id: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional(),
            before_time: z.string().datetime({ offset: true }).optional(),
        },
        handler: async (args, { client }) => {
            const a = args as {
                issue_type: IssueType;
                id: string;
                action: UpdateAction;
                agent_id?: string;
                patch?: Record<string, unknown>;
                status?: string;
                body?: string;
                to_id?: string;
                relation_type?: z.infer<typeof RelationTypeSchema>;
                link_id?: number | string;
                before_time?: string;
            };
            const actor = a.agent_id ?? null;
            switch (a.action) {
                case 'patch_fields': {
                    if (!a.patch)
                        throw new Error("update_item: `patch` is required for action='patch_fields'");
                    return toToolResult(await client.updateItem(a.issue_type, a.id, a.patch, actor));
                }
                case 'change_status': {
                    if (!a.status)
                        throw new Error("update_item: `status` is required for action='change_status'");
                    return toToolResult(
                        await client.transitionItemStatus(a.issue_type, a.id, a.status, actor),
                    );
                }
                case 'add_comment': {
                    if (!a.body)
                        throw new Error("update_item: `body` is required for action='add_comment'");
                    // Always 'agent': an MCP caller can't prove it is the
                    // Owner, and an Owner-chip comment is trusted downstream.
                    return toToolResult(
                        await client.addComment({
                            issue_type: a.issue_type,
                            issue_id: a.id,
                            body: a.body,
                            agent_id: actor,
                        }),
                    );
                }
                case 'add_link': {
                    if (!a.to_id || !a.relation_type)
                        throw new Error(
                            "update_item: `to_id` + `relation_type` are required for action='add_link'",
                        );
                    return toToolResult(
                        await client.createItemLink(
                            {
                                from_type: a.issue_type,
                                from_id: a.id,
                                to_id: a.to_id,
                                relation_type: a.relation_type,
                            },
                            actor,
                        ),
                    );
                }
                case 'remove_link': {
                    if (a.link_id === undefined)
                        throw new Error("update_item: `link_id` is required for action='remove_link'");
                    await client.deleteItemLink(Number(a.link_id), actor);
                    return toToolResult({ deleted: true, link_id: Number(a.link_id) });
                }
                case 'remove_history': {
                    if (!a.before_time)
                        throw new Error(
                            "update_item: `before_time` is required for action='remove_history'",
                        );
                    return toToolResult(
                        await client.pruneItemHistory(a.issue_type, a.id, a.before_time, actor),
                    );
                }
            }
        },
    },
    {
        name: 'delete_item',
        title: 'Delete an item (cascade on children)',
        description: [
            'Permanently delete an item. Deleting a task also deletes its sub-tasks and removes its run checkouts; a sub-task has no children.',
            '',
            'Returns `{ deleted: true, issue_type, id }`.',
            '',
            'Use sparingly — the activity log loses the item context once it is gone. Required: `issue_type` + `id`.',
        ].join('\n'),
        group_name: 'ITEMS',
        sort_order: 24,
        inputSchema: {
            issue_type: IssueTypeSchema,
            id: z.string().min(1),
        },
        handler: async (args, { client }) => {
            const { issue_type, id } = args as { issue_type: IssueType; id: string };
            await client.deleteItem(issue_type, id);
            return toToolResult({ deleted: true, issue_type, id });
        },
    },
];

export function registerItemTools(server: McpServer, client: IApiClient): void {
    for (const t of ITEM_TOOLS) {
        server.registerTool(
            t.name,
            { title: t.title, description: t.description, inputSchema: t.inputSchema },
            (args) => t.handler(args, { client }),
        );
    }
}
