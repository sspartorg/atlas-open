import { expect, type APIRequestContext } from '@playwright/test';

// Direct calls to the e2e API (global-setup.ts) for seeding what a spec needs.

export const API = 'http://127.0.0.1:6001';
// Mirrors global-setup.ts: the env file the e2e API reads and writes, and the
// port its Telegram calls go to.
export const E2E_ENV_FILE = new URL('../../e2e-logs/e2e.env', import.meta.url).pathname;
export const FAKE_TELEGRAM_PORT = 6091;
// The e2e seed's only project (fixtures/run-seed.ts).
const PROJECT_ID = 'e2e-terminal-project';
export const PROJECT_NAME = 'E2E Terminal';

export async function apiPost<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
    const res = await request.post(`${API}${path}`, { data });
    expect(res.status(), `POST ${path}: ${await res.text()}`).toBeLessThan(300);
    return (await res.json()) as T;
}

export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
    const res = await request.get(`${API}${path}`);
    expect(res.status(), `GET ${path}: ${await res.text()}`).toBeLessThan(300);
    return (await res.json()) as T;
}

/** The agent the e2e seed installs (fixtures/run-seed.ts). */
export const SEEDED_AGENT = 'agent-solo';

/**
 * A Task in the seeded project. With `agent` it is created queued (Ready) and
 * dispatch starts its run at once. AI is off in e2e, so the agent's step is a
 * simulated pass; the seeded project has no credential, so delivery's push
 * fails and the run parks waiting for the Owner (`workflow.failed`).
 */
export function createTask(request: APIRequestContext, title: string, agent?: string) {
    return apiPost<{ id: string; status: string }>(request, '/api/tasks', {
        project_id: PROJECT_ID,
        title,
        ...(agent ? { assignee_agent_id: agent } : {}),
    });
}

/** The Task's runs, newest first (`GET /api/items/:id/workflow-runs`). */
export function taskRuns(request: APIRequestContext, taskId: string) {
    return apiGet<Array<{ id: string; status: string; park_reason: string | null }>>(request, `/api/items/${taskId}/workflow-runs`);
}

/** The Owner steps in: stop the Task's live run (if any), then close the Task. */
export async function closeTask(request: APIRequestContext, taskId: string) {
    const live = (await taskRuns(request, taskId)).find((r) => r.status === 'running' || r.status === 'waiting_for_owner');
    if (live) await apiPost(request, `/api/workflow-runs/${live.id}/stop`, {});
    const res = await request.patch(`${API}/api/tasks/${taskId}/status?override=1`, { data: { status: 'done' } });
    expect(res.status(), await res.text()).toBeLessThan(300);
}
