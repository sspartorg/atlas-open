import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IApiClient } from '../api-client.js';
import type { ToolRegistration } from '../registrations.js';

function toToolResult(payload: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
}

// Projects are read-only over MCP. Git lives on the project's repos
// (`project_repos`, ADR 0017/0018), not on the project row.
export const PROJECT_TOOLS: ToolRegistration[] = [
    {
        name: 'listProjects',
        title: 'List all projects',
        description:
            'Return every project, newest first. Each row carries id, name, issue_key_prefix, ' +
            'description, status, guardrails_md, team_managed, jira_status_map, created_at, ' +
            'updated_at, last_activity_at. Repos are not included — call getProject for them. ' +
            'Use this to find the project_id a new Task belongs in.',
        group_name: 'PROJECTS',
        sort_order: 40,
        inputSchema: {},
        handler: async (_args, { client }) => toToolResult(await client.listProjects()),
    },
    {
        name: 'getProject',
        title: 'Get one project by id, with its repos',
        description:
            'Return one project (the same fields as listProjects) plus `repos`: its git repos ' +
            '(id, name, git_url, git_path, default_branch, clone_status, credential_id, setup scripts). ' +
            'No repo is primary. A Task picks repos by id (`create_item` → `repo_ids`).',
        group_name: 'PROJECTS',
        sort_order: 41,
        inputSchema: { id: z.string().min(1) },
        handler: async ({ id }: { id: string }, { client }) =>
            toToolResult(await client.getProject(id)),
    },
];

export function registerProjectTools(server: McpServer, client: IApiClient): void {
    for (const t of PROJECT_TOOLS) {
        server.registerTool(
            t.name,
            { title: t.title, description: t.description, inputSchema: t.inputSchema },
            (args) => t.handler(args, { client }),
        );
    }
}
