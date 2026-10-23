import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, AtlasApiError } from './api-client.js';
import type { IAgent } from '@atlas/shared';

const config = {
    apiBase: 'http://api.test',
    requestTimeoutMs: 5000,
    mcpToken: 'unit-secret',
};

const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

const okEmpty = () => new Response(null, { status: 204 });

const sampleAgent: IAgent = {
    id: 'a1',
    name: 'PO Writer',
    category: 'software-dev',
    cli: 'claude',
    model: 'claude-opus-4-7',
    framework: '',
    prompt_md: '',
    prompt_version: 1,
    status: 'active',
    accent_color: '#007AC9',
    sort_order: 1,
    description: '',
    designation: '',
    kind: 'performer',
    reviewer_agent_id: null,
    glyph: '',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('createApiClient — agent endpoints', () => {
    it('listAgents hits /api/agents with GET and no token header', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([sampleAgent]));
        const out = await createApiClient(config).listAgents();
        expect(out).toEqual([sampleAgent]);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/agents');
        expect((init as RequestInit).method).toBe('GET');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBeUndefined();
    });

    it('getAgent fans out to two parallel GETs', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson(sampleAgent))
            .mockResolvedValueOnce(okJson([]));
        const out = await createApiClient(config).getAgent('a1');
        const urls = fetchSpy.mock.calls.map((c) => c[0]).sort();
        expect(urls).toEqual([
            'http://api.test/api/agents/a1',
            'http://api.test/api/agents/a1/checklists',
        ]);
        expect(out.agent).toEqual(sampleAgent);
    });

    it('createAgent POSTs the payload with the token header, then re-fetches the composite', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ ...sampleAgent, id: 'a1' })) // POST
            .mockResolvedValueOnce(okJson(sampleAgent)) // GET agent
            .mockResolvedValueOnce(okJson([])); // checklists
        await createApiClient(config).createAgent({
            id: 'a1',
            name: 'PO Writer',
            category: 'software-dev',
            cli: 'claude',
            model: 'claude-opus-4-7',
            accent_color: '#007AC9',
        });
        const [postUrl, postInit] = fetchSpy.mock.calls[0]!;
        expect(postUrl).toBe('http://api.test/api/agents');
        expect((postInit as RequestInit).method).toBe('POST');
        const headers = (postInit as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBe('unit-secret');
        expect(headers['Content-Type']).toBe('application/json');
        expect(JSON.parse((postInit as RequestInit).body as string)).toMatchObject({
            id: 'a1',
            name: 'PO Writer',
        });
    });

    it('updateAgent PATCHes and refetches', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson(sampleAgent)) // PATCH
            .mockResolvedValueOnce(okJson(sampleAgent))
            .mockResolvedValueOnce(okJson([]));
        await createApiClient(config).updateAgent('a1', {
            description: 'New description',
        });
        const [patchUrl, patchInit] = fetchSpy.mock.calls[0]!;
        expect(patchUrl).toBe('http://api.test/api/agents/a1');
        expect((patchInit as RequestInit).method).toBe('PATCH');
        const headers = (patchInit as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBe('unit-secret');
    });

    it('tolerates empty 204 responses (decoded as undefined)', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okEmpty()) // PATCH returns 204
            .mockResolvedValueOnce(okJson(sampleAgent))
            .mockResolvedValueOnce(okJson([]));
        const out = await createApiClient(config).updateAgent('a1', { description: 'x' });
        expect(out.agent).toEqual(sampleAgent);
    });

    it('encodes id segments with reserved characters', async () => {
        // getAgent fires parallel requests; each call needs its own Response
        // instance because a body can only be read once.
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (url) => {
                if (typeof url === 'string' && url.endsWith('/weird%20id%2Fslash')) {
                    return okJson(sampleAgent);
                }
                return okJson([]);
            });
        await createApiClient(config).getAgent('weird id/slash');
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
        expect(urls).toContain('http://api.test/api/agents/weird%20id%2Fslash');
        expect(urls).toContain(
            'http://api.test/api/agents/weird%20id%2Fslash/checklists'
        );
    });

    it('throws AtlasApiError on non-2xx with snippet body', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } })
        );
        const err = await createApiClient(config).listAgents().catch((e) => e);
        expect(err).toBeInstanceOf(AtlasApiError);
        expect(err.status).toBe(500);
        expect(err.bodySnippet).toBe('boom');
        expect(err.message).toContain('500');
    });

    it('coalesces unreadable error bodies to an empty snippet', async () => {
        const broken = new Response('ignored', { status: 502 });
        vi.spyOn(broken, 'text').mockRejectedValue(new Error('stream broken'));
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(broken);
        const err = await createApiClient(config).listAgents().catch((e) => e);
        expect(err).toBeInstanceOf(AtlasApiError);
        expect(err.bodySnippet).toBe('');
    });

    it('truncates the error snippet at 200 chars', async () => {
        const long = 'x'.repeat(500);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(long, { status: 400, headers: { 'content-type': 'text/plain' } })
        );
        const err = await createApiClient(config).listAgents().catch((e) => e);
        expect(err.bodySnippet.length).toBe(200);
    });

    it('aborts the request when the configured timeout fires', async () => {
        vi.useFakeTimers();
        try {
            vi.spyOn(globalThis, 'fetch').mockImplementation(
                (_url, init) =>
                    new Promise((_resolve, reject) => {
                        const signal = (init as RequestInit | undefined)?.signal;
                        signal?.addEventListener('abort', () =>
                            reject(new DOMException('aborted', 'AbortError'))
                        );
                    })
            );
            const promise = createApiClient({
                apiBase: 'http://api.test',
                requestTimeoutMs: 100,
                mcpToken: '',
            }).listAgents();
            const settled = vi.fn();
            promise.catch(settled);
            await vi.advanceTimersByTimeAsync(150);
            await Promise.resolve();
            expect(settled).toHaveBeenCalled();
            const [err] = settled.mock.calls[0] ?? [];
            expect((err as Error).name).toBe('AbortError');
        } finally {
            vi.useRealTimers();
        }
    });

    it('omits the token header when mcpToken is empty', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson(sampleAgent))
            .mockResolvedValueOnce(okJson(sampleAgent))
            .mockResolvedValueOnce(okJson([]))
            .mockResolvedValueOnce(okJson([]))
            .mockResolvedValueOnce(okJson([]));
        await createApiClient({
            apiBase: 'http://api.test',
            requestTimeoutMs: 5000,
            mcpToken: '',
        }).updateAgent('a1', { description: 'x' });
        const [, init] = fetchSpy.mock.calls[0]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBeUndefined();
    });
});

describe('createApiClient — sub-task endpoints', () => {
    // Sub-tasks are a nested resource under their task. The REST surface is
    // /api/tasks/:id/sub-tasks, not a flat /api/sub-tasks — posting to the
    // flat URL 404'd every create (see the MON-6 incident). The test locks
    // the URL shape so the route mismatch can't drift back.

    it('createSubTask posts to /api/tasks/:id/sub-tasks', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ id: 'ST1', task_id: 'ATL-2' }));
        await createApiClient(config).createSubTask({
            task_id: 'ATL-2',
            title: 'Wire X',
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/ATL-2/sub-tasks');
        expect((init as RequestInit).method).toBe('POST');
        // task_id is in the URL; body must not duplicate it (route's
        // schema re-injects it from the path, but keeping the body
        // narrow makes the contract clearer).
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).not.toHaveProperty('task_id');
        expect(body.title).toBe('Wire X');
    });

    it('createSubTask URL-encodes the task id', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ id: 'ST1' }));
        await createApiClient(config).createSubTask({
            task_id: 'ATL 2/x',
            title: 't',
        });
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/ATL%202%2Fx/sub-tasks');
    });
});

describe('createApiClient — agent lifecycle (delete + memory)', () => {
    it('deleteAgent issues a DELETE with the token header', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okEmpty());
        await createApiClient(config).deleteAgent('a1');
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/agents/a1');
        expect((init as RequestInit).method).toBe('DELETE');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBe('unit-secret');
    });

    it('getAgentMemory hits /memory with GET', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ agent_id: 'a1', body_md: '#m', version: 2 }));
        const out = await createApiClient(config).getAgentMemory('a1');
        expect(out.agent_id).toBe('a1');
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/agents/a1/memory');
        expect((init as RequestInit).method).toBe('GET');
    });

    it('updateAgentMemory PUTs the payload with the token header', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ agent_id: 'a1', body_md: '#m', version: 3 }));
        await createApiClient(config).updateAgentMemory('a1', {
            body_md: '## section\n- note',
            mode: 'append',
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/agents/a1/memory');
        expect((init as RequestInit).method).toBe('PUT');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.mode).toBe('append');
        expect(body.body_md).toContain('- note');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBe('unit-secret');
    });

});

describe('createApiClient — marketplace', () => {
    it('searchMarketplaceAgents builds a query string from filters', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson([]));
        await createApiClient(config).searchMarketplaceAgents({
            query: 'po',
            category: 'software-dev',
            kind_slug: 'jira-to-epic',
            limit: 5,
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toContain('/api/marketplace/agents?');
        expect(url).toContain('q=po');
        expect(url).toContain('category=software-dev');
        expect(url).toContain('kind=jira-to-epic');
        expect(url).toContain('limit=5');
        expect((init as RequestInit).method).toBe('GET');
    });

    it('searchMarketplaceAgents omits the qs entirely when no filters supplied', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson([]));
        await createApiClient(config).searchMarketplaceAgents({});
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/marketplace/agents');
    });

    it('getMarketplaceAgent fetches a single composite by id', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ agent: { id: 'mp1' } }));
        await createApiClient(config).getMarketplaceAgent('mp1');
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/marketplace/agents/mp1');
    });
});

describe('createApiClient — issue create endpoints', () => {
    it('createTask POSTs to /api/tasks with the payload', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 'T1' }));
        await createApiClient(config).createTask({ project_id: 'p1', title: 'New' }, null);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks');
        expect((init as RequestInit).method).toBe('POST');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            project_id: 'p1',
            title: 'New',
        });
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['X-Atlas-Token']).toBe('unit-secret');
    });
});

describe('createApiClient — comments', () => {
    it('addComment always posts author=agent with the given agent_id', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson({ id: 1 }));
        const client = createApiClient(config);
        await client.addComment({ issue_type: 'task', issue_id: 'S1', body: 'hi', agent_id: null });
        await client.addComment({ issue_type: 'task', issue_id: 'S1', body: 'hi', agent_id: 'a1' });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/comments');
        expect((init as RequestInit).method).toBe('POST');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            author: 'agent',
            agent_id: null,
            issue_type: 'task',
            issue_id: 'S1',
            body: 'hi',
        });
        const second = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
        expect(second.author).toBe('agent');
        expect(second.agent_id).toBe('a1');
    });
});

describe('createApiClient — items (getItemFull / search / projects / links)', () => {
    it('getItemFull maps issue_type to the route segment and splices comments + project repos into the envelope', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockImplementation(async (url) => {
            if (typeof url === 'string' && url.includes('/api/comments')) {
                return okJson([{ id: 1, body: 'hi' }]);
            }
            if (typeof url === 'string' && url.endsWith('/repos')) return okJson([{ id: 'r1' }]);
            return okJson({ stub: true, project: { id: 'p 1' } });
        });
        const client = createApiClient(config);
        const out = await client.getItemFull('task', 'S1');
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string).sort();
        expect(urls).toEqual([
            'http://api.test/api/comments?issue_type=task&issue_id=S1',
            'http://api.test/api/projects/p%201/repos',
            'http://api.test/api/tasks/S1/full',
        ]);
        expect(out).toEqual({
            stub: true,
            project: { id: 'p 1' },
            repos: [{ id: 'r1' }],
            comments: [{ id: 1, body: 'hi' }],
        });
    });

    it('getItemFull URL-encodes issue ids for both fanout calls', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockImplementation(async () => okJson([]));
        await createApiClient(config).getItemFull('sub_task', 'ATL 9/x');
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string).sort();
        expect(urls).toEqual([
            'http://api.test/api/comments?issue_type=sub_task&issue_id=ATL%209%2Fx',
            'http://api.test/api/sub-tasks/ATL%209%2Fx/full',
        ]);
    });

    it('searchItems sends the cap as `limit`, the param /api/search reads', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson([]));
        await createApiClient(config).searchItems('foo bar', 7);
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/search?q=foo+bar&limit=7');
    });

    it('listProjects + getProject hit the projects routes; getProject adds the repos', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockImplementation(async (url) => {
            if (url === 'http://api.test/api/projects') return okJson([]);
            if (typeof url === 'string' && url.endsWith('/repos')) return okJson([{ id: 'r1' }]);
            return okJson({ id: 'p 1' });
        });
        const client = createApiClient(config);
        await client.listProjects();
        const project = await client.getProject('p 1');
        expect(project).toEqual({ id: 'p 1', repos: [{ id: 'r1' }] });
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string).sort();
        expect(urls).toEqual([
            'http://api.test/api/projects',
            'http://api.test/api/projects/p%201',
            'http://api.test/api/projects/p%201/repos',
        ]);
    });

    it('createItemLink POSTs to from-item links endpoint', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 1 }));
        await createApiClient(config).createItemLink({
            from_type: 'task',
            from_id: 'S1',
            to_id: 'S2',
            relation_type: 'depends_on',
        }, null);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/issues/task/S1/links');
        expect((init as RequestInit).method).toBe('POST');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.to_id).toBe('S2');
        expect(body.relation_type).toBe('depends_on');
    });

    it('deleteItemLink DELETEs by linkId', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okEmpty());
        await createApiClient(config).deleteItemLink(42, null);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/issues/links/42');
        expect((init as RequestInit).method).toBe('DELETE');
    });

    it('pruneItemHistory POSTs before_time + forwards agent id header', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                okJson({ comments_deleted: 2, events_deleted: 3, owner_comments_preserved: 1 }),
            );
        const result = await createApiClient(config).pruneItemHistory(
            'task',
            'ATL-1',
            '2026-06-01T00:00:00Z',
            'agent-coder',
        );
        expect(result).toEqual({
            comments_deleted: 2,
            events_deleted: 3,
            owner_comments_preserved: 1,
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/issues/task/ATL-1/history/prune');
        const req = init as RequestInit;
        expect(req.method).toBe('POST');
        expect(JSON.parse(req.body as string)).toEqual({ before_time: '2026-06-01T00:00:00Z' });
        // x-atlas-agent-id is forwarded so the audit event can attribute
        // the destructive call to the bound MCP identity.
        expect((req.headers as Record<string, string>)['x-atlas-agent-id']).toBe('agent-coder');
    });

    it('create* / item-link writes forward the agent id as x-atlas-agent-id (and omit it when null)', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => okJson({ id: 1 }));
        const client = createApiClient(config);
        await client.createTask({ project_id: 'p1', title: 'T' }, 'agent-po-writer');
        await client.createSubTask({ task_id: 'T1', title: 't' }, 'agent-po-writer');
        await client.createItemLink(
            { from_type: 'task', from_id: 'S2', to_id: 'S1', relation_type: 'tested_by' },
            'agent-po-writer',
        );
        await client.deleteItemLink(5, 'agent-po-writer');
        await client.updateItem('task', 'S1', { title: 'x' }, 'agent-po-writer');
        await client.createTask({ project_id: 'p1', title: 'T' }, null);
        const agentHeaders = fetchSpy.mock.calls.map(
            ([, init]) => ((init as RequestInit).headers as Record<string, string>)['x-atlas-agent-id'],
        );
        expect(agentHeaders).toEqual([...Array(5).fill('agent-po-writer'), undefined]);
    });

});

describe('createApiClient — reminders + notifications', () => {
    it('setReminder POSTs payload', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 1 }));
        await createApiClient(config).setReminder({
            label: 'ping',
            schedule: { kind: 'once', at: '2099-01-01T00:00:00Z' },
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/reminders');
        expect((init as RequestInit).method).toBe('POST');
    });

    it('updateReminder PATCHes by id', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 1 }));
        await createApiClient(config).updateReminder(1, { label: 'renamed' });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/reminders/1');
        expect((init as RequestInit).method).toBe('PATCH');
    });

    it('cancelReminder DELETEs (returns updated row)', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ id: 1, status: 'cancelled' }));
        await createApiClient(config).cancelReminder(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/reminders/1');
        expect((init as RequestInit).method).toBe('DELETE');
    });

    it('snoozeReminder POSTs the minutes to /snooze', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 1 }));
        await createApiClient(config).snoozeReminder(1, 10);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/reminders/1/snooze');
        expect((init as RequestInit).method).toBe('POST');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ minutes: 10 });
    });

    it('listReminders GETs /api/reminders (no filter args = empty query string)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson([]));
        await createApiClient(config).listReminders();
        expect(fetchSpy.mock.calls[0]![0]).toBe('http://api.test/api/reminders');
    });

    it('listReminders builds a filter query string when status/channel/since are supplied', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson([]));
        await createApiClient(config).listReminders({
            status: 'active',
            channel: 'external',
            since: '2026-07-01T00:00:00Z',
        });
        const url = fetchSpy.mock.calls[0]![0] as string;
        expect(url).toContain('/api/reminders?');
        expect(url).toContain('status=active');
        expect(url).toContain('channel=external');
        expect(url).toContain('since=2026-07-01T00');
    });

    it('sendExternalNotification POSTs to /api/notifications/send-external', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(okJson({ ok: true }));
        await createApiClient(config).sendExternalNotification({
            message: 'hi',
            event_key: 'agent.daily-digest',
        });
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/notifications/send-external');
        expect((init as RequestInit).method).toBe('POST');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({ message: 'hi', event_key: 'agent.daily-digest' });
    });
});

describe('createApiClient — item mutation (polymorphic)', () => {
    it('updateItem PATCHes the per-type route with patch body', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 'S1' }));
        await createApiClient(config).updateItem('task', 'S1', {
            title: 'new',
            spec_md: '## spec',
        }, null);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/S1');
        expect((init as RequestInit).method).toBe('PATCH');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.spec_md).toBe('## spec');
    });

    it('transitionItemStatus PATCHes /status (never with ?override)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({}));
        await createApiClient(config).transitionItemStatus('task', 'S1', 'in_progress', null);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/S1/status');
        expect((init as RequestInit).method).toBe('PATCH');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({ status: 'in_progress' });
    });

    it('transitionItemStatus adds requested_by_agent_id when supplied', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({}));
        await createApiClient(config).transitionItemStatus('task', 'S1', 'done', 'agent-po-reviewer');
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/S1/status');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({ status: 'done', requested_by_agent_id: 'agent-po-reviewer' });
    });

    it('deleteItem DELETEs the per-type route', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okEmpty());
        await createApiClient(config).deleteItem('sub_task', 'ST1');
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/sub-tasks/ST1');
        expect((init as RequestInit).method).toBe('DELETE');
    });

    it('updateItem maps task → /api/tasks/:id', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 'T1' }));
        await createApiClient(config).updateItem('task', 'T1', { title: 'renamed' }, null);
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/tasks/T1');
    });

    it('updateItem maps sub_task → /api/sub-tasks/:id', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ id: 'ST1' }));
        await createApiClient(config).updateItem('sub_task', 'ST1', { title: 'done' }, null);
        const [url] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('http://api.test/api/sub-tasks/ST1');
    });
});

describe('AtlasApiError', () => {
    it('captures status, url, and snippet', () => {
        const e = new AtlasApiError(418, 'http://x/y', 'short');
        expect(e.status).toBe(418);
        expect(e.url).toBe('http://x/y');
        expect(e.bodySnippet).toBe('short');
        expect(e.message).toContain('418');
    });

    it('prefixes 4xx messages with a [atlas-api-NNN] marker for log highlighting', () => {
        const e = new AtlasApiError(400, 'http://x/y', 'bad body');
        expect(e.message.startsWith('[atlas-api-400] ')).toBe(true);
    });

    it('does not prefix 5xx messages', () => {
        const e = new AtlasApiError(503, 'http://x/y', 'gateway');
        expect(e.message.startsWith('[atlas-api-')).toBe(false);
    });
});
