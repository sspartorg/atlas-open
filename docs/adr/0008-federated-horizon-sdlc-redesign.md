# 0008. Federated Horizon SDLC Redesign

**Date:** 2026-06-03
**Status:** Accepted

> Atlas Open was released with fresh git history; the squash below happened in the history this edition was forked from, which is not part of this repository.

## Context

Between Atlas's initial Phase 1-5 releases (2026-05-11) and the multi-week redesign that followed, the SDLC pipeline was rebuilt from the ground up. The work was tracked across seventeen federated horizon plans (P1-P17) covering: the unified items table, depends-on, the role catalog (A08), Telegram notifications (A09), reminders (A10), the dependency-guard (B04), context-aware reply (A12), the two-persona reviewer model, search (B16), the agent runtime hot path, the marketplace, the prompt builder, the constitution, the scheduler, the dispatch flow, the Postgres migration, and the Knex baseline.

By 2026-06-03 the redesign had landed across approximately 552 commits. The branch history at that point carried a high noise-to-signal ratio: refactor-of-refactor commits, half-finished experiments that were superseded, fixes for issues introduced earlier in the same sprint. The codebase was at 1667 tests passing — a credible state to draw a line on. The squash decision: that history is not worth preserving in git as the public record of how we got here; what matters is the artifact we shipped.

## Decision

Squash the 552-commit redesign history into a single initial-release commit on 2026-06-03. New work commits cleanly on top of the squashed baseline. The 17-plan federated horizon design is baked into the squashed code; the per-plan narrative lives in `.agents/` documentation rather than in commit history.

The squash drew the line: anything in the squash commit and earlier is "old Atlas" archival; anything after is the canonical post-redesign codebase.

## Consequences

- Git log for the redesign period is gone. The 17-plan narrative survives in `.agents/` (architecture, data-model, api-surface, mcp, testing).
- The repository public-state is clean. New contributors do not have to wade through redesign churn to read recent history.
- The 1667-test baseline at squash time is the floor. Subsequent changes must not regress this.
- Federated horizon plan numbering (P1-P17, A06-A12, B04-B16, C01-C07, Theme 06-13) is referenced throughout the code and docs. Those references are historical signposts; the current state of any feature is what is in code, not what plan number originally introduced it.
