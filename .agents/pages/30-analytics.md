# Analytics

**Route:** `/analytics`  •  **Component:** `packages/web/src/pages/Analytics.tsx` (one file, no tabs)

## Purpose
The basics over a window the Owner picks, in the Owner's timezone: how much shipped, how fast, and what it cost. Cut down on 2026-10-23 from three tabs (Overview / Delivery / Spend) and two drill-down pages (Owner: "too many details for an open application"); the drill-downs `/analytics/project/:id` and `/analytics/task/:id` are gone.

## States
- Loading: a skeleton (`aria-busy`, `aria-label="Loading"`) — four tile blocks and one chart block.
- Error: `Alert severity="error"` "Could not load analytics: <message>".
- Empty: the tiles read `0`, `0`, `—` (no cycle time), `$0.00`, and the chart draws zero-filled buckets.

## UI elements

**Header** — `PageHeader` (`analytics` icon). Subtitle: "What shipped, how fast and what it cost, for {October 2026 | the last N days}. Times are in {viewer tz}."
- **Window** `ToggleButtonGroup` (header actions): `7 days` · `30 days` · `90 days` · `This month`. URL `?window=7d|30d|90d`; `month` (default) clears the param so the first load matches the Dashboard's month spend. On phones the group drops to its own line under the title and stretches full width. An unknown `?window=` reads as `month`.

**Four tiles** (2 per row on phones, 4 from `md`), each with an info button (`aria-label="How {label} is measured"`) whose tooltip is the definition:
- **Tasks shipped** — Tasks whose first move into Done falls in the window (sub-tasks and agent tests left out).
- **PRs merged** — PRs opened by Task runs that started in the window, merged as last checked on GitHub (the fleet page's maths, `agent-scorecard.ts` `runPrs`).
- **Median cycle time** — a Task's first In progress → its first Done, median over the shipped Tasks; `—` when none has one.
- **Spend** — completed agent runs plus closed terminal sessions in the window.

**Shipped and spent, per day|week** (h2) — two bar charts on one time axis (`syncId`), each with its own y-axis: Tasks shipped, then spend.

## Modals / drawers
None.

## Hooks used
- `useAnalytics(window)` → `['analytics', window]` (`hooks/useAnalytics.ts`, 30 s stale). The viewer tz is sent as `?tz=` by `api.analytics.get`.

## API endpoints touched
- `GET /api/analytics?tz&window` → `IAnalytics` — see `api-surface.md`.

## Permissions / guards
- Post-onboarding only. Read-only.

## Edge cases / quirks
- **The month boundary is local, and the timestamp column is UTC.** Verify against the same `tz` the page sent before filing a mismatch.
- `window=month` is the month start in the viewer's zone. The Dashboard sends the same zone (`GET /api/dashboard?tz=`) and resolves the month with the same `resolveWindow`, so its "this month" spend equals this page's month Spend (`routes/analytics.test.ts` "the Dashboard month agrees with Analytics").
- 90 days buckets by Monday weeks (`date_trunc('week')`), server side.
- Agent-test items (`items.is_test`) are left out of every number (`notTestRun` in `services/analytics-window.ts`); a run with no item (a standalone agent run) is real spend and stays. Their cost stays visible on the agent's Tests tab.
- A malformed or unknown `tz` is a 400 (`AnalyticsQuerySchema`), as is an unknown `window` or any other query key.
- Chart colours come from `CHART_PALETTE` (`theme/tokens.ts`).

## Related pages
- [`36-fleet-performance.md`](36-fleet-performance.md) — the agent comparison (from the Agents page header)
- [`01-dashboard.md`](01-dashboard.md) — the month-spend figure that must agree with this page

## Coming soon on this page
- None.
