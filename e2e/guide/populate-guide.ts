// Phase 2 of the guide stack (scripts/guide-stack.sh): give every page the
// guide photographs real content, made through the API the way the Owner would
// make it — and REAL agent runs, so Runs, Analytics, diffs, Tests and terminal
// history show what Atlas actually produced rather than SIMULATED canned text.
//
// This spends real tokens (a few dollars). Nothing leaves the machine: the
// repos' origins are local bare repos under /tmp/atlas-open-guide/origins, so a
// run's push lands there (and its PR, with no GitHub remote, parks the run).
//
// Run: pnpm guide:populate

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { API } from '../helpers/api.js';
const PROJECT = 'acme-notes';
const REPO_API = 'acme-notes-api';
const REPO_WEB = 'acme-notes-web';
const DATA = '/tmp/atlas-open-guide';

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[guide] ${new Date().toISOString().slice(11, 19)} ${msg}`);

// ---------------------------------------------------------------- static data

log('credentials, secrets, guard-rails, reminders, scratch pad, jira');
await call('POST', '/api/credentials', {
    label: 'Acme GitHub (bot)',
    username: 'acme-bot',
    // Never used: nothing in the guide stack pushes. It exists so the page has a row.
    token: 'example-not-a-real-token',
    scope: 'acme/*',
    human_name: 'Alex Rivera',
    human_email: 'alex@acme.example',
});
await call('PUT', '/api/environment-secrets', {
    vars: [
        { key: 'NPM_TOKEN', value: 'npm_exampleNotReal' },
        { key: 'SENTRY_DSN', value: 'https://example@sentry.invalid/1' },
    ],
});
await call('POST', '/api/guardrails', {
    category: 'secrets_credentials',
    rule_text: 'Never print or commit the contents of .env files.',
    detail: 'Reference secrets as ${variable.KEY} in setup scripts instead.',
    severity: 'block',
});
await call('POST', '/api/guardrails', {
    category: 'escalation_scope',
    rule_text: 'Ask the Owner before adding a new runtime dependency.',
    detail: null,
    severity: 'ask_owner',
});
await call('POST', `/api/projects/${PROJECT}/guardrails`, {
    title: 'Keep notes-api dependency-free',
    body_md: 'notes-api ships with zero npm dependencies. Use the Node standard library.',
    icon: 'shield',
});
await call('POST', '/api/reminders', {
    label: 'Review open pull requests',
    body: 'Check what is waiting in review before standup.',
    schedule: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time_of_day: '09:30' },
    channel: 'notification',
});
await call('POST', '/api/reminders', {
    label: 'Release notes-api 0.2.0',
    body: '',
    schedule: { kind: 'once', at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    channel: 'both',
});
await call('POST', '/api/scratch-pad', {
    title: 'Ideas',
    body_md: '- Markdown export for notes\n- Pin a note to the top\n- Dark theme for notes-web',
});
await call('POST', '/api/scratch-pad', {
    title: 'Release checklist',
    body_md: '1. Bump version\n2. Update CHANGELOG\n3. Tag `v0.2.0`',
});
await call('PUT', '/api/integrations/jira', {
    enabled: false,
    site_url: 'https://acme.atlassian.net',
    email: 'alex@acme.example',
    api_token: 'exampleNotReal',
    poll_interval_minutes: 60,
});

// --------------------------------------------------------------------- agent

log('install the Solo Engineer');
const AGENT = 'agent-solo';
await call('POST', `/api/marketplace/agents/${AGENT}/install`, {});
// A Jira source (Import stays off, so nothing is polled): the project's Jira tab
// shows what a configured source looks like.
await call('POST', `/api/projects/${PROJECT}/jira-sources`, {
    jql: 'project = NOTES AND labels = atlas AND statusCategory = "To Do"',
    agent_id: AGENT,
    repo_ids: [REPO_API],
});

// ---------------------------------------------------------------------- tasks

log('tasks');
type Item = { id: string };
const task = (title: string, description: string, repo_ids: string[], extra: Record<string, unknown> = {}) =>
    call<Item>('POST', '/api/tasks', { project_id: PROJECT, title, description, repo_ids, ...extra });

const tagFilter = await task(
    'Filter notes by tag',
    'Add `listNotes({ tag })` to notes-api so callers can list only the notes carrying a given tag. Without a tag it keeps returning every note. Cover it with tests.',
    [REPO_API],
    { priority: 'high', acceptance_criteria: '- `listNotes({ tag: "work" })` returns only notes tagged `work`\n- `listNotes()` is unchanged\n- `npm test` passes' },
);
const search = await task(
    'Search notes by title',
    'Add `searchNotes(query)` to notes-api: a case-insensitive substring match on the title. Cover it with tests.',
    [REPO_API],
);
const count = await task(
    'Show the note count in the page header',
    'notes-web should show "Acme Notes (3)" in the header, using a count helper exported from notes-api.',
    [REPO_API, REPO_WEB],
    { priority: 'normal' },
);
await task('Export notes to Markdown', 'A `toMarkdown(notes)` helper that renders each note as a `##` section.', [REPO_API], {
    priority: 'low',
});
await task('Pin a note to the top of the list', 'Pinned notes sort before the rest in `listNotes()`.', [REPO_API], {
    priority: 'normal',
    labels: ['ux'],
});

// ------------------------------------------------------------------ real runs

type Run = { id: string; status: string };
/** Assigning the agent queues the Task; dispatch starts its run. */
async function start(itemId: string): Promise<void> {
    await call('PATCH', `/api/tasks/${itemId}/assign`, { assignee_agent_id: AGENT });
}

async function waitSettled(itemId: string, label: string, timeoutMin: number): Promise<Run | undefined> {
    const until = Date.now() + timeoutMin * 60_000;
    let last = '';
    while (Date.now() < until) {
        const runs = await call<Run[]>('GET', `/api/items/${itemId}/workflow-runs`);
        const run = runs[0];
        if (run && run.status !== last) {
            last = run.status;
            log(`${label}: ${run.status}`);
        }
        if (run && run.status !== 'running') return run;
        await sleep(15_000);
    }
    log(`${label}: still running after ${timeoutMin} min — moving on`);
    return undefined;
}

log('starting real runs ×3');
await start(tagFilter.id);
await start(count.id);
await waitSettled(tagFilter.id, `${tagFilter.id} run`, 45);
await start(search.id);

// Agent tests while the other runs work: the Tests tab needs a real verdict.
log('test suite: Solo Engineer');
await call('POST', `/api/agents/${AGENT}/test-suite/runs`, { n_runs: 1 }).catch((e) => log(String(e)));

// Terminal sessions are NOT made here — they need a browser to get past
// Claude's folder-trust prompt, so the capture spec drives them (see
// "terminal sessions (real)").
// The standalone terminal's folder; the capture spec opens a session in it.
const standaloneDir = join(DATA, 'scratch', 'release-notes');
mkdirSync(standaloneDir, { recursive: true });
writeFileSync(join(standaloneDir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- First release of notes-api.\n');

await waitSettled(search.id, `${search.id} run`, 45);
await waitSettled(count.id, `${count.id} run`, 60);

log('done');
