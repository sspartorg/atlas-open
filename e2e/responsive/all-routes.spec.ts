import { test, expect, type Page } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { API, SEEDED_AGENT, apiGet, apiPost, closeTask, createTask, taskRuns } from '../helpers/api.js';

// Every route at every viewport. Runs under mobile-chrome (390), ipad-chrome
// (834), tablet-landscape (1194), laptop-1366 and — for `@xbrowser` routes —
// Firefox and iPhone WebKit. Each route must render its heading, keep its
// navigation reachable, and never scroll sideways or push a control off-screen.

const PROJECT = 'e2e-terminal-project';

type Ids = { run: string; agentRun: string; session: string; market: string };
let ids: Ids;
let taskId = '';
let sessionId = '';

test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    // A run: a Task with the seeded agent parks waiting for the Owner (AI off, no credential).
    taskId = (await createTask(request, 'Responsive sweep run', SEEDED_AGENT)).id;
    await expect.poll(async () => (await taskRuns(request, taskId))[0]?.id, { timeout: 60_000 }).toBeTruthy();
    const run = (await taskRuns(request, taskId))[0]!.id;
    // An itemless run of the seeded agent (simulated: AI is off in e2e).
    const agentRun = (await apiGet<Array<{ id: string }>>(request, '/api/run'))[0]?.id
        ?? (await apiPost<{ runId: string }>(request, '/api/run', { agent_id: SEEDED_AGENT })).runId;
    const session = (await apiGet<Array<{ id: string }>>(request, '/api/cli/sessions'))[0]?.id
        ?? (sessionId = (await apiPost<{ id: string }>(request, '/api/cli/sessions', { project_id: PROJECT })).id);
    const market = (await apiGet<Array<{ id: string }>>(request, '/api/marketplace/agents'))[0]!.id;
    ids = { run, agentRun, session, market };
});

test.afterAll(async ({ request }) => {
    if (taskId) await closeTask(request, taskId);
    if (sessionId) await request.post(`${API}/api/cli/sessions/${sessionId}/stop`, { data: { open_pull_request: false } });
});

// [path, xbrowser]. Paths needing ids are functions.
const ROUTES: Array<[string | ((i: Ids) => string), boolean]> = [
    ['/', true],
    ['/projects', false],
    [`/projects/${PROJECT}`, true],
    ['/tasks', false],
    ['/tasks/new', true],
    ['/tasks/ETM-1', true],
    ['/sub-tasks/ETM-2', false],
    ['/queue', false],
    [(i) => `/runs/${i.run}`, true],
    ['/search?q=E2E', false],
    ['/agents', false],
    [`/agents/${SEEDED_AGENT}`, false],
    ['/agents/performance', false],
    [(i) => `/agents/${SEEDED_AGENT}/runs/${i.agentRun}`, false],
    ['/agents/marketplace', false],
    [(i) => `/agents/marketplace/${i.market}`, false],
    ['/agents/mcp-tools', false],
    ['/analytics', false],
    ['/notifications', false],
    ['/guardrails', false],
    ['/settings', false],
    ['/settings/credentials', false],
    ['/reminders', false],
    ['/scratch-pad', false],
    ['/terminal', true],
    ['/terminal/standalone', false],
    ['/terminal/layout', false],
    [(i) => `/terminal/${i.session}`, false],
    [(i) => `/terminal/${i.session}/history`, false],
];

/** Interactive controls whose box sticks out past the viewport's right edge. */
async function clippedControls(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return [...document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="combobox"]')]
            .filter((el) => {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                // Inside a horizontal scroller (tab strips, tables, xterm) is fine.
                for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                    const s = getComputedStyle(p);
                    if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && p.scrollWidth > p.clientWidth) return false;
                }
                return r.right > w + 1;
            })
            .map((el) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}"`);
    });
}

for (const [route, xbrowser] of ROUTES) {
    const label = typeof route === 'string' ? route : route.toString().match(/`([^`]+)`/)?.[1] ?? 'dynamic';
    test(`${label} fits the viewport @mobile @ipad @sweep${xbrowser ? ' @xbrowser' : ''}`, async ({ page }) => {
        const path = typeof route === 'string' ? route : route(ids);
        // xterm/WS teardown on navigation is the only expected failure noise.
        await goto(page, path, { allow: [/\/stream/, /WebSocket/] });

        await expect(page.locator('main h1, main [role="heading"]').first()).toBeVisible({ timeout: 15_000 });

        const narrow = (page.viewportSize()?.width ?? 0) < 900;
        if (narrow) await expect(page.locator('.MuiBottomNavigation-root')).toBeVisible();
        else await expect(page.locator('[data-testid^="nav-item-"]').first()).toBeVisible();

        const { scroll, client } = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
        }));
        expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
        expect(await clippedControls(page), 'controls cut off at the right edge').toEqual([]);
        // SWEEP_SHOTS=<dir> saves what each viewport saw, for a by-eye pass.
        const shots = process.env['SWEEP_SHOTS'];
        if (shots) await page.screenshot({ path: `${shots}/${test.info().project.name}${path.replace(/[/?=]/g, '_')}.png` });
    });
}
