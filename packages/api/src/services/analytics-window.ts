import { sql } from 'kysely';
import type { AnalyticsWindow, IAnalyticsPeriod } from '@atlas/shared';
import { db } from '../db/kysely-client.js';
import { iso } from './agent-scorecard.js';

// Allow `Area/Location` style IANA names plus UTC. Anything else falls back to UTC.
const TZ_RE = /^[A-Za-z_+\-/]{1,64}$/;

export function normalizeTz(raw: unknown): string {
    if (typeof raw !== 'string' || !TZ_RE.test(raw)) return 'UTC';
    // A well-formed but unknown zone would otherwise reach Postgres as a 500.
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: raw });
        return raw;
    } catch {
        return 'UTC';
    }
}

const DAYS: Record<Exclude<AnalyticsWindow, 'month'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Resolve `?window=` into absolute bounds, computed in Postgres in the
 * viewer's tz so every bucket and boundary is the viewer's wall clock (the
 * month-boundary rule in `.agents/pages/30-analytics.md`).
 *
 * - `month`: this calendar month so far.
 * - `Nd`: today plus the N-1 local days before it.
 *
 * `now` is a parameter so tests can pin the clock.
 */
export async function resolveWindow(
    tz: string,
    window: AnalyticsWindow,
    now: Date = new Date(),
): Promise<IAnalyticsPeriod> {
    const n = now.toISOString();
    const days = window === 'month' ? 0 : DAYS[window];
    const res = await sql<{ start: unknown }>`
        WITH l AS (SELECT (${n}::timestamptz AT TIME ZONE ${tz}) AS ln)
        SELECT (CASE WHEN ${window} = 'month' THEN date_trunc('month', ln)
                     ELSE date_trunc('day', ln) - make_interval(days => ${days} - 1) END) AT TIME ZONE ${tz} AS start
          FROM l
    `.execute(db);
    return {
        window,
        tz,
        bucket: window === '90d' ? 'week' : 'day',
        start: iso(res.rows[0]?.start) ?? n,
        end: n,
    };
}

/**
 * Agent-test runs (`items.is_test`) are left out of spend, as they are of
 * every other Analytics number — and of the Dashboard's month spend, so the
 * two still agree. Their cost is on the agent's Tests tab. A run with no item
 * (a standalone agent run) is real spend and stays in.
 */
export function notTestRun(itemIdColumn: string) {
    return sql<boolean>`NOT EXISTS (SELECT 1 FROM items ti WHERE ti.id = ${sql.ref(itemIdColumn)} AND ti.is_test)`;
}

/** Zero-filled bucket keys (`YYYY-MM-DD`, Monday for weeks) across a window, in the viewer's tz. */
export async function windowBuckets(period: IAnalyticsPeriod): Promise<string[]> {
    const { tz, start, end, bucket: unit } = period;
    const r = await sql<{ bucket: string }>`
        SELECT to_char(d, 'YYYY-MM-DD') AS bucket
          FROM generate_series(
                   date_trunc(${unit}, ${start}::timestamptz AT TIME ZONE ${tz}),
                   ${end}::timestamptz AT TIME ZONE ${tz},
                   ('1 ' || ${unit})::interval) d
    `.execute(db);
    return r.rows.map((x) => x.bucket);
}
