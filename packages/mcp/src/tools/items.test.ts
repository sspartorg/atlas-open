import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ITEM_TOOLS, registerItemTools } from './items.js';
import type { IApiClient } from '../api-client.js';

type Handler<T = unknown> = (input: T) => Promise<CallToolResult>;

interface CapturedTool {
    name: string;
    config: { title?: string; description?: string; inputSchema?: unknown };
    handler: Handler<unknown>;
}

function captureServer(): { server: McpServer; tools: Map<string, CapturedTool> } {
    const tools = new Map<string, CapturedTool>();
    const server = {
        registerTool: (
            name: string,
            config: CapturedTool['config'],
            handler: Handler<unknown>,
        ) => {
            tools.set(name, { name, config, handler });
        },
    } as unknown as McpServer;
    return { server, tools };
}

function parseToolResult<T = unknown>(r: CallToolResult): T {
    const block = r.content[0];
    if (!block || block.type !== 'text') throw new Error('Expected text block');
    return JSON.parse(block.text) as T;
}

function makeFakeApiClient(overrides: Partial<IApiClient> = {}): IApiClient {
    const notStubbed = (name: string) => () => {
        throw new Error(`api-client method "${name}" not stubbed for this test`);
    };
    return new Proxy(overrides, {
        get(target, prop: string) {
            if (prop in target) return (target as Record<string, unknown>)[prop];
            return notStubbed(prop);
        },
    }) as IApiClient;
}

const schemaOf = (name: string) =>
    z.object(ITEM_TOOLS.find((t) => t.name === name)!.inputSchema as z.ZodRawShape);

describe('ITEM_TOOLS registration', () => {
    it('registers exactly the 5 consolidated item tools', () => {
        const { server, tools } = captureServer();
        registerItemTools(server, makeFakeApiClient());
        expect([...tools.keys()].sort()).toEqual(
            ['create_item', 'delete_item', 'get_item', 'search_item', 'update_item'].sort(),
        );
    });

    it('update_item documents every action it accepts, and no routing / PR action', () => {
        const entry = ITEM_TOOLS.find((t) => t.name === 'update_item')!;
        for (const action of [
            'patch_fields',
            'change_status',
            'add_comment',
            'add_link',
            'remove_link',
            'remove_history',
        ]) {
            expect(entry.description).toContain(`'${action}'`);
        }
        const schema = schemaOf('update_item');
        for (const action of ['assign', 'add_external_link', 'remove_external_link']) {
            expect(schema.safeParse({ issue_type: 'task', id: 'S1', action }).success).toBe(false);
            expect(entry.description).not.toContain(`'${action}'`);
        }
    });
});

describe('search_item', () => {
    it('forwards query + top_k and returns the FTS hits', async () => {
        const { server, tools } = captureServer();
        const hit = { issue_type: 'task', issue_id: 'ATL-1', title: 'Onboarding', rank: 0.9 };
        const searchItems = vi.fn().mockResolvedValue([hit]);
        registerItemTools(server, makeFakeApiClient({ searchItems }));
        const result = await tools.get('search_item')!.handler({ query: 'INT-401', top_k: 5 });
        expect(searchItems).toHaveBeenCalledWith('INT-401', 5);
        expect(parseToolResult(result)).toEqual([hit]);
    });

    it('defaults top_k to 10, as the description says', async () => {
        const { server, tools } = captureServer();
        const searchItems = vi.fn().mockResolvedValue([]);
        registerItemTools(server, makeFakeApiClient({ searchItems }));
        await tools.get('search_item')!.handler({ query: 'INT-401' });
        expect(searchItems).toHaveBeenCalledWith('INT-401', 10);
        expect(ITEM_TOOLS.find((t) => t.name === 'search_item')!.description).toContain('default 10');
    });
});

describe('create_item', () => {
    it("issue_type='task' forwards to client.createTask", async () => {
        const { server, tools } = captureServer();
        const createTask = vi.fn().mockResolvedValue({ id: 'T1' });
        registerItemTools(server, makeFakeApiClient({ createTask }));
        await tools.get('create_item')!.handler({
            issue_type: 'task',
            payload: { project_id: 'p1', title: 'task', repo_ids: ['r1'] },
        });
        expect(createTask).toHaveBeenCalledWith({ project_id: 'p1', title: 'task', repo_ids: ['r1'] }, null);
    });

    it("issue_type='sub_task' forwards to client.createSubTask with task_id, status and labels", async () => {
        const { server, tools } = captureServer();
        const createSubTask = vi.fn().mockResolvedValue({ id: 'ST1' });
        registerItemTools(server, makeFakeApiClient({ createSubTask }));
        const payload = { task_id: 'T1', title: 't', status: 'ready', labels: ['qa'] };
        await tools.get('create_item')!.handler({ issue_type: 'sub_task', payload });
        expect(createSubTask).toHaveBeenCalledWith(payload, null);
    });

    it('forwards `agent_id` to the client so the API can attribute the create', async () => {
        const { server, tools } = captureServer();
        const createTask = vi.fn().mockResolvedValue({ id: 'T1' });
        registerItemTools(server, makeFakeApiClient({ createTask }));
        await tools.get('create_item')!.handler({
            issue_type: 'task',
            agent_id: 'agent-po-writer',
            payload: { project_id: 'p1', title: 'task' },
        });
        expect(createTask).toHaveBeenCalledWith({ project_id: 'p1', title: 'task' }, 'agent-po-writer');
    });

    it('the schema rejects unknown keys, assignees and retired item kinds', () => {
        const schema = schemaOf('create_item');
        const base = { issue_type: 'sub_task', payload: { task_id: 'T1', title: 't' } };
        expect(schema.safeParse(base).success).toBe(true);
        for (const extra of [{ story_id: 'S1' }, { assignee_agent_id: 'a1' }, { steps_to_reproduce: 'x' }]) {
            expect(schema.safeParse({ ...base, payload: { ...base.payload, ...extra } }).success).toBe(false);
        }
        expect(schema.safeParse({ ...base, issue_type: 'story' }).success).toBe(false);
        // A payload of neither kind fails validation.
        expect(schema.safeParse({ issue_type: 'task', payload: { title: 't' } }).success).toBe(false);
    });

    it('rejects a payload of the other kind with a clear error', async () => {
        const { server, tools } = captureServer();
        registerItemTools(server, makeFakeApiClient());
        await expect(
            tools.get('create_item')!.handler({ issue_type: 'task', payload: { task_id: 'T1', title: 't' } }),
        ).rejects.toThrow(/not a valid task payload \(it needs `project_id`/);
        await expect(
            tools.get('create_item')!.handler({
                issue_type: 'sub_task',
                payload: { project_id: 'p1', title: 't' },
            }),
        ).rejects.toThrow(/not a valid sub_task payload \(it needs `task_id`/);
    });
});

describe('get_item', () => {
    it('forwards (issue_type, id) to client.getItemFull', async () => {
        const { server, tools } = captureServer();
        const getItemFull = vi.fn().mockResolvedValue({ task: { id: 'S1' }, comments: [] });
        registerItemTools(server, makeFakeApiClient({ getItemFull }));
        const result = await tools.get('get_item')!.handler({ issue_type: 'task', id: 'S1' });
        expect(getItemFull).toHaveBeenCalledWith('task', 'S1');
        expect(parseToolResult<{ task: { id: string } }>(result).task.id).toBe('S1');
    });
});

describe('update_item', () => {
    it("action='patch_fields' passes patch + agent_id through to client.updateItem", async () => {
        const { server, tools } = captureServer();
        const updateItem = vi.fn().mockResolvedValue({ id: 'ATL-2' });
        registerItemTools(server, makeFakeApiClient({ updateItem }));
        const update = tools.get('update_item')!.handler;
        await update({
            issue_type: 'task',
            id: 'ATL-2',
            action: 'patch_fields',
            patch: { title: 'new title', labels: ['x'] },
        });
        await update({
            issue_type: 'task',
            id: 'ATL-2',
            action: 'patch_fields',
            patch: { title: 't' },
            agent_id: 'agent-po-writer',
        });
        expect(updateItem).toHaveBeenNthCalledWith(1, 'task', 'ATL-2', { title: 'new title', labels: ['x'] }, null);
        expect(updateItem).toHaveBeenNthCalledWith(2, 'task', 'ATL-2', { title: 't' }, 'agent-po-writer');
    });

    it("action='patch_fields' schema rejects the delivery fields agents don't own", () => {
        const schema = schemaOf('update_item');
        const base = { issue_type: 'task', id: 'SDB-2', action: 'patch_fields' };
        expect(schema.safeParse({ ...base, patch: { spec_md: '## s' } }).success).toBe(true);
        for (const patch of [
            { pr_url: 'https://github.com/o/r/pull/1' },
            { worktree_branch: 'atlas/wf/SDB-2' },
            { assignee_agent_id: 'a1' },
        ]) {
            expect(schema.safeParse({ ...base, patch }).success).toBe(false);
        }
    });

    it("action='patch_fields' surfaces per-type Zod rejections from the API", async () => {
        const { server, tools } = captureServer();
        const updateItem = vi.fn().mockRejectedValue(new Error('Atlas API 400 ...'));
        registerItemTools(server, makeFakeApiClient({ updateItem }));
        await expect(
            tools.get('update_item')!.handler({
                issue_type: 'sub_task',
                id: 'ATL-1',
                action: 'patch_fields',
                patch: { spec_md: 'sub-tasks do not accept spec_md' },
            }),
        ).rejects.toThrow(/Atlas API 400/);
    });

    it("action='change_status' forwards status + agent_id to transitionItemStatus", async () => {
        const { server, tools } = captureServer();
        const transitionItemStatus = vi.fn().mockResolvedValue({ id: 'ATL-2' });
        registerItemTools(server, makeFakeApiClient({ transitionItemStatus }));
        const update = tools.get('update_item')!.handler;
        await update({ issue_type: 'task', id: 'ATL-2', action: 'change_status', status: 'in_progress' });
        await update({
            issue_type: 'task',
            id: 'ATL-2',
            action: 'change_status',
            status: 'in_review',
            agent_id: 'agent-po-reviewer',
        });
        expect(transitionItemStatus).toHaveBeenNthCalledWith(1, 'task', 'ATL-2', 'in_progress', null);
        expect(transitionItemStatus).toHaveBeenNthCalledWith(2, 'task', 'ATL-2', 'in_review', 'agent-po-reviewer');
    });

    it("action='change_status' schema has no override and only takes real statuses", () => {
        const schema = schemaOf('update_item');
        const base = { issue_type: 'task', id: 'S1', action: 'change_status' };
        expect(schema.safeParse({ ...base, status: 'done' }).success).toBe(true);
        expect(schema.safeParse({ ...base, status: 'archived' }).success).toBe(false);
        expect('override' in (ITEM_TOOLS.find((t) => t.name === 'update_item')!.inputSchema)).toBe(false);
    });

    it("action='add_comment' always posts as an agent, with the given or null agent_id", async () => {
        const { server, tools } = captureServer();
        const addComment = vi.fn().mockResolvedValue({ id: 99 });
        registerItemTools(server, makeFakeApiClient({ addComment }));
        const update = tools.get('update_item')!.handler;
        await update({ issue_type: 'task', id: 'S1', action: 'add_comment', body: 'hello', agent_id: 'agent-coder' });
        await update({ issue_type: 'task', id: 'S1', action: 'add_comment', body: 'no id' });
        expect(addComment).toHaveBeenNthCalledWith(1, {
            issue_type: 'task',
            issue_id: 'S1',
            body: 'hello',
            agent_id: 'agent-coder',
        });
        expect(addComment).toHaveBeenNthCalledWith(2, {
            issue_type: 'task',
            issue_id: 'S1',
            body: 'no id',
            agent_id: null,
        });
        expect('author' in (ITEM_TOOLS.find((t) => t.name === 'update_item')!.inputSchema)).toBe(false);
    });

    it("add_link / remove_link forward the link and `agent_id` to the client", async () => {
        const { server, tools } = captureServer();
        const createItemLink = vi.fn().mockResolvedValue({ id: 1 });
        const deleteItemLink = vi.fn().mockResolvedValue(undefined);
        registerItemTools(server, makeFakeApiClient({ createItemLink, deleteItemLink }));
        const update = tools.get('update_item')!.handler;
        await update({ issue_type: 'task', id: 'S1', action: 'add_link', to_id: 'S2', relation_type: 'depends_on' });
        await update({
            issue_type: 'task',
            id: 'S2',
            agent_id: 'agent-po-writer',
            action: 'add_link',
            to_id: 'S1',
            relation_type: 'tested_by',
        });
        const removed = await update({ issue_type: 'task', id: 'S1', action: 'remove_link', link_id: 42 });
        // get_item returns bigint link ids as strings; those are accepted as-is.
        await update({ issue_type: 'task', id: 'S1', action: 'remove_link', link_id: '9', agent_id: 'agent-po-writer' });
        expect(schemaOf('update_item').safeParse({ issue_type: 'task', id: 'S1', action: 'remove_link', link_id: '9' }).success).toBe(true);
        expect(schemaOf('update_item').safeParse({ issue_type: 'task', id: 'S1', action: 'remove_link', link_id: 'x' }).success).toBe(false);
        expect(createItemLink).toHaveBeenNthCalledWith(
            1,
            { from_type: 'task', from_id: 'S1', to_id: 'S2', relation_type: 'depends_on' },
            null,
        );
        expect(createItemLink.mock.calls[1]![1]).toBe('agent-po-writer');
        expect(deleteItemLink).toHaveBeenNthCalledWith(1, 42, null);
        expect(deleteItemLink).toHaveBeenNthCalledWith(2, 9, 'agent-po-writer');
        expect(parseToolResult(removed)).toEqual({ deleted: true, link_id: 42 });
    });

    it("action='remove_history' forwards item + before_time + agent_id to client.pruneItemHistory", async () => {
        const { server, tools } = captureServer();
        const counts = { comments_deleted: 4, events_deleted: 7, owner_comments_preserved: 0 };
        const pruneItemHistory = vi.fn().mockResolvedValue(counts);
        registerItemTools(server, makeFakeApiClient({ pruneItemHistory }));
        const result = await tools.get('update_item')!.handler({
            issue_type: 'task',
            id: 'ATL-1',
            action: 'remove_history',
            before_time: '2026-06-01T00:00:00Z',
            agent_id: 'agent-coder',
        });
        expect(pruneItemHistory).toHaveBeenCalledWith('task', 'ATL-1', '2026-06-01T00:00:00Z', 'agent-coder');
        expect(parseToolResult(result)).toEqual(counts);
    });

    it('throws when an action is missing its required fields', async () => {
        const { server, tools } = captureServer();
        registerItemTools(server, makeFakeApiClient());
        const update = tools.get('update_item')!.handler;
        const base = { issue_type: 'task', id: 'S1' };
        await expect(update({ ...base, action: 'patch_fields' })).rejects.toThrow(
            /`patch` is required for action='patch_fields'/,
        );
        await expect(update({ ...base, action: 'add_comment' })).rejects.toThrow(
            /`body` is required for action='add_comment'/,
        );
        await expect(update({ ...base, action: 'change_status' })).rejects.toThrow(
            /`status` is required for action='change_status'/,
        );
        await expect(update({ ...base, action: 'add_link' })).rejects.toThrow(
            /`to_id` \+ `relation_type` are required for action='add_link'/,
        );
        await expect(update({ ...base, action: 'remove_link' })).rejects.toThrow(
            /`link_id` is required for action='remove_link'/,
        );
        await expect(update({ ...base, action: 'remove_history' })).rejects.toThrow(
            /`before_time` is required for action='remove_history'/,
        );
    });
});

describe('delete_item', () => {
    it('returns {deleted:true, issue_type, id} on success', async () => {
        const { server, tools } = captureServer();
        const deleteItem = vi.fn().mockResolvedValue(undefined);
        registerItemTools(server, makeFakeApiClient({ deleteItem }));
        const result = await tools.get('delete_item')!.handler({
            issue_type: 'sub_task',
            id: 'ATL-99',
        });
        expect(deleteItem).toHaveBeenCalledWith('sub_task', 'ATL-99');
        expect(parseToolResult(result)).toEqual({ deleted: true, issue_type: 'sub_task', id: 'ATL-99' });
    });

    it('propagates 404 errors from the client', async () => {
        const { server, tools } = captureServer();
        const deleteItem = vi.fn().mockRejectedValue(new Error('Atlas API 404'));
        registerItemTools(server, makeFakeApiClient({ deleteItem }));
        await expect(
            tools.get('delete_item')!.handler({ issue_type: 'task', id: 'missing' }),
        ).rejects.toThrow(/404/);
    });
});
