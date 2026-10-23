import { sql } from 'kysely';
import type { AnalyticsWindow, IAnalytics } from '@atlas/shared';
import { db } from '../db/kysely-client.js';
import { runPrs, scoreAgents } from './agent-scorecard.js';
import { notTestRun, resolveWindow, windowBuckets } from './analytics-window.js';

// `GET /api/analytics`: four numbers and one per-bucket series over a window.
// Agent-test items (`items.is_test`) are left out throughout.
//
// Definitions (the web states each one next to its number):
//   shipped    — a Task's FIRST move into Done (`issue_events`) falls in the window
//   cycle time — that Task's first In progress → first Done; none if it never entered In progress before Done
//   PRs merged — PRs opened by Task runs started in the window, merged as last checked (the fleet page's maths)
//   spend      — completed agent runs + closed terminal sessions in the window

/** Linear-interpolated percentile over an ascending list — the same answer as Postgres `percentile_cont`. */
export function percentileCont(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    const a = sorted[lo] ?? 0;
    const b = sorted[hi] ?? 0;
    return a + (b - a) * (i - lo);
}

export async function analytics(opts: { tz: string; window: AnalyticsWindow; now?: Date }): Promise<IAnalytics> {
    const period = await resolveWindow(opts.tz, opts.window, opts.now);
    const { tz, start, end, bucket: unit } = period;
    const bucketOf = (col: string) => sql<string>`to_char(date_trunc(${unit}, ${sql.ref(col)} AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;

    const [buckets, shipped, spend, card] = await Promise.all([
        windowBuckets(period),
        // An item whose first Done is in the window has a Done event in the
        // window, so the candidates come from the window's events first
        // (`idx_issue_events_status_created_at`) and only their history is
        // read. HAVING keeps the answer exact.
        sql<{ bucket: string; cycle_s: string | null }>`
            SELECT ${bucketOf('f.done_at')} AS bucket,
                   CASE WHEN f.ip_at <= f.done_at THEN EXTRACT(EPOCH FROM f.done_at - f.ip_at) END AS cycle_s
              FROM (
                  SELECT e.item_id,
                         MIN(e.created_at) FILTER (WHERE e.to_value = 'done') AS done_at,
                         MIN(e.created_at) FILTER (WHERE e.to_value = 'in_progress') AS ip_at
                    FROM issue_events e
                   WHERE e.field = 'status' AND e.created_at < ${end}::timestamptz
                     AND e.item_id IN (
                         SELECT d.item_id FROM issue_events d
                          WHERE d.field = 'status' AND d.to_value = 'done'
                            AND d.created_at >= ${start}::timestamptz AND d.created_at < ${end}::timestamptz
                     )
                   GROUP BY e.item_id
                  HAVING MIN(e.created_at) FILTER (WHERE e.to_value = 'done') >= ${start}::timestamptz
              ) f
              JOIN items i ON i.id = f.item_id AND NOT i.is_test AND i.type = 'task'
        `.execute(db),
        sql<{ bucket: string; usd: string | null }>`
            SELECT bucket, SUM(usd)::text AS usd FROM (
                SELECT ${bucketOf('completed_at')} AS bucket, total_cost_usd::numeric AS usd
                  FROM agent_runs
                 WHERE status = 'completed' AND ${notTestRun('agent_runs.item_id')}
                   AND completed_at >= ${start}::timestamptz AND completed_at < ${end}::timestamptz
                UNION ALL
                SELECT ${bucketOf('closed_at')}, total_cost_usd::numeric
                  FROM cli_sessions
                 WHERE status = 'closed' AND closed_at >= ${start}::timestamptz AND closed_at < ${end}::timestamptz
            ) s
             GROUP BY bucket
        `.execute(db),
        scoreAgents({ since: start, until: end }),
    ]);
    const prs = await runPrs(card);

    const series = new Map(buckets.map((b) => [b, { bucket: b, tasks_shipped: 0, spend_usd: 0 }]));
    for (const r of shipped.rows) {
        const b = series.get(r.bucket);
        if (b) b.tasks_shipped += 1;
    }
    for (const r of spend.rows) {
        const b = series.get(r.bucket);
        if (b) b.spend_usd = Number(r.usd ?? 0);
    }
    const cycles = shipped.rows
        .map((r) => (r.cycle_s === null ? null : Number(r.cycle_s)))
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);

    return {
        period,
        tasks_shipped: shipped.rows.length,
        prs_merged: prs.reduce((n, r) => n + r.merged, 0),
        cycle_p50_s: percentileCont(cycles, 0.5),
        spend_usd: spend.rows.reduce((n, r) => n + Number(r.usd ?? 0), 0),
        series: [...series.values()],
    };
}
