import type { Knex } from 'knex';

// Atlas Open has one agent per Task and no PO Writer / Architect / QA Writer /
// Automation pipeline. The baseline and the seed still shipped that
// pipeline's gates, templates and rules, and every run staged them into the
// worktree and told the agent to run them.
//
// - Guard-rail scripts: the four role gates go. `seed.ts` upserts and never
//   deletes, so existing installs keep them until this runs. `prereqs` stays
//   (the seed rewrites it). Project copies the Owner made
//   (`project_guardrail_scripts`) are theirs and stay.
// - Templates: no shipped agent reads `.atlas/templates/`, and the seed no
//   longer carries any. `story` is the pre-ADR-0015 name the seed used to
//   delete on every boot.
// - The `po` role prompt described `[QA]` / `[DOC]` twins. 002 cleared the
//   other role prompts and missed this one.
// - Guard-rail rules from the baseline: the git rules assumed agents commit
//   and push (they never do; Atlas does, ADR 0015), and three others named
//   Coder, Spec Writer, Stories or a reviewer. Each row changes only while it
//   still holds the baseline text, so a rule the Owner edited is left alone.

export const RETIRED_SCRIPT_IDS = ['po-writer-output', 'architect-spec-md', 'qa-writer-csv', 'check-automation-tests'];
export const RETIRED_TEMPLATE_IDS = ['spec', 'plan', 'tasks', 'sub-task', 'qa-plan', 'story'];

interface RuleText {
    rule_text: string;
    detail: string;
    severity: 'block' | 'ask_owner' | 'warn';
}

export const RULE_REWRITES: Array<{ id: string; from: RuleText; to: RuleText }> = [
    {
        id: 'seed-git-no-force-push',
        from: {
            rule_text: 'Never force-push (git push --force, --force-with-lease, +ref) to any branch.',
            detail: 'Force-push silently overwrites history shared with other contributors. Open a new branch instead.',
            severity: 'block',
        },
        to: {
            rule_text: 'Never run `git commit`, `git push` or `gh` - Atlas commits, pushes and opens the pull request when your run ends.',
            detail: "Leave your changes in the working tree. Atlas commits whatever the run leaves, on the Task's branch.",
            severity: 'block',
        },
    },
    {
        id: 'seed-git-no-history-rewrite',
        from: {
            rule_text: 'Never rewrite history (rebase, --amend, filter-branch, reset --hard) on a branch that has been pushed.',
            detail: 'Local-only rebases on un-pushed feature branches are fine; rewriting shared history is not.',
            severity: 'block',
        },
        to: {
            rule_text: "Never switch branches or create worktrees (`git checkout <branch>`, `git switch`, `git worktree`) - stay on the Task's branch.",
            detail: 'The run owns one branch and one worktree per repo. Work done anywhere else is not what Atlas commits and pushes.',
            severity: 'block',
        },
    },
    {
        id: 'seed-git-cherrypick-revert',
        from: {
            rule_text: 'Cherry-picking, reverting commits, or reflog manipulation requires Owner confirmation.',
            detail: 'These are sharp tools - one wrong pick can resurrect deleted work or hide it.',
            severity: 'ask_owner',
        },
        to: {
            rule_text: "Never rewrite or discard history (`git rebase`, `git reset --hard`, `git cherry-pick`, `git revert`, `git stash`) on the Task's branch.",
            detail: 'An earlier run of this Task may have left work on the branch. These commands can drop it, or hide it where Atlas never commits it.',
            severity: 'block',
        },
    },
    {
        id: 'seed-esc-scope-expansion',
        from: {
            rule_text: 'Expanding the run scope beyond the assigned issue requires Owner confirmation.',
            detail: 'An agent on Story X must not silently address Story Y. If the change scope grows, pause and ask.',
            severity: 'ask_owner',
        },
        to: {
            rule_text: 'Expanding the run scope beyond the assigned Task requires Owner confirmation.',
            detail: 'An agent on Task X must not silently address Task Y. If the change scope grows, pause and ask.',
            severity: 'ask_owner',
        },
    },
    {
        id: 'seed-esc-spec-discrepancy',
        from: {
            rule_text: 'If a Coder agent finds a Spec discrepancy, it must pause and ask the Owner - never silently rewrite the Spec.',
            detail: 'Spec ownership belongs to the Spec Writer / Owner, not to Coder.',
            severity: 'ask_owner',
        },
        to: {
            rule_text: "If the Task's description or acceptance criteria contradict the code or each other, pause and ask the Owner - never silently pick one.",
            detail: 'The Task belongs to the Owner. Changing what it asks for is their call, not the agent\'s.',
            severity: 'ask_owner',
        },
    },
    {
        id: 'seed-net-no-test-execution',
        from: {
            rule_text:
                'Run the project test suite only inside the worktree Atlas provisioned for the item you are working on. Never run it anywhere else, and never treat a local pass as the merge gate.',
            detail: 'Test runners (pnpm test, vitest, jest, mocha, playwright test, cypress, pytest, go test, cargo test, rspec, phpunit) are ALLOWED inside your own item worktree, so a reviewer can confirm tests execute green rather than merely parse. They stay BLOCKED everywhere else: never against the main checkout, another item worktree, or any deployed environment. A local pass is evidence for your checklist, not the merge gate - that remains .github/workflows/test.yml.',
            severity: 'block',
        },
        to: {
            rule_text:
                'Run the project test suite only inside the worktree Atlas provisioned for your Task. Never run it anywhere else, and never treat a local pass as the merge gate.',
            detail: "Test runners (pnpm test, vitest, jest, mocha, playwright test, cypress, pytest, go test, cargo test, rspec, phpunit) are ALLOWED inside your Task's worktree, so you can confirm tests execute green rather than merely parse. They stay BLOCKED everywhere else: never against the main checkout, another Task's worktree, or any deployed environment. A local pass is evidence for your summary, not the merge gate - that remains the project's CI.",
            severity: 'block',
        },
    },
];

export async function up(knex: Knex): Promise<void> {
    await knex('guardrail_scripts').whereIn('id', RETIRED_SCRIPT_IDS).delete();
    await knex('agent_templates').whereIn('id', RETIRED_TEMPLATE_IDS).delete();
    await knex('roles').where('id', 'po').update({ default_prompt_md: '', updated_at: knex.fn.now() });
    for (const r of RULE_REWRITES) {
        await knex('guardrail_rules')
            .where({ id: r.id, rule_text: r.from.rule_text, detail: r.from.detail, severity: r.from.severity })
            .update({ ...r.to, updated_at: knex.fn.now() });
    }
}

export async function down(_knex: Knex): Promise<void> {
    // No-op: the deleted scripts and templates checked and shaped the output
    // of roles this edition does not run, and the old rule text described an
    // agent that commits.
}
