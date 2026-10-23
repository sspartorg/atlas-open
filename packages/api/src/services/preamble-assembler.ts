// Renders the centralized "read these files" preamble the runner prepends to
// every agent's slash-command body (and to the audit prompt snapshot), so
// catalog prompts don't repeat it.
//
// Kept as a pure function (no I/O, no DB) so callers compose it with
// `buildPrompt` output without worrying about ordering side-effects.

export function assemblePreamble(agentId: string): string {
    return [
        `You are agent \`${agentId}\`. Before doing anything else, read these files at the working-directory root:`,
        '',
        '1. `.atlas/constitution.md` — the project\'s rules of engagement',
        '2. `.atlas/current-task.md` — the item this run targets (absent when the run works on the project as a whole)',
        '3. `.atlas/outcome.md` — how to report this run\'s result; Atlas acts on it',
        '4. `.atlas/self-memory.md` — your past course-corrections',
        '5. `.atlas/changed-files.md` — what this branch has already touched; read it before searching the repo',
        '',
        'You are the agent running this Task. Do the whole job by editing files, and end with the `atlas-outcome` block. Do not run `git commit`, `git push` or `gh`, and do not assign the item or change its status — Atlas commits, pushes and opens the PR when your run ends.',
    ].join('\n');
}
