import { useCallback, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { useSearchParams } from 'react-router-dom';
import { ANALYTICS_WINDOWS, type AnalyticsWindow } from '@atlas/shared';
import { useSetPageTitle } from '../components/shell/index.js';
import { PageHeader } from '../components/PageHeader.js';
import { useAnalytics } from '../hooks/useAnalytics.js';
import { ATLAS_PALETTE, CHART_PALETTE, TYPOGRAPHY } from '../theme/tokens.js';
import { formatCostUsd } from '../utils/formatCost.js';
import { formatSpan } from '../utils/time.js';

// /analytics — four numbers and one chart over one window (`?window=`).

const WINDOW_LABEL: Record<AnalyticsWindow, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
    month: 'This month',
};

const TOOLTIP_STYLE = {
    contentStyle: {
        fontSize: 12,
        background: ATLAS_PALETTE.surfaceRaised,
        borderRadius: '10px',
        border: `1px solid ${ATLAS_PALETTE.slate10}`,
        boxShadow: 'var(--atlas-elevation-mid)',
        color: ATLAS_PALETTE.slate,
    },
    labelStyle: { fontWeight: 600, color: ATLAS_PALETTE.slate },
    itemStyle: { color: ATLAS_PALETTE.slate },
    cursor: { fill: 'rgba(127,127,127,.10)' },
} as const;

const AXIS_TICK = { fontSize: 11, fill: ATLAS_PALETTE.slate60, fontFamily: TYPOGRAPHY.fontFamilyMono };

// Compact so a fixed-width axis never clips: $950, $1.2k, $15k.
const usdTick = (v: number) =>
    Math.abs(v) >= 1000 ? `$${Number((v / 1000).toFixed(v >= 10_000 ? 0 : 1))}k` : `$${v}`;
const usdTooltip = (v: unknown) => formatCostUsd(Number(v));

/** `2026-10-12` → "Oct 12", read as a local calendar date (no UTC drift). */
function bucketLabel(ymd: string): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// `month` is the default so the Dashboard's month spend and this page agree
// on first load.
function useWindowParam(): [AnalyticsWindow, (w: AnalyticsWindow) => void] {
    const [params, setParams] = useSearchParams();
    const raw = params.get('window');
    const window = (ANALYTICS_WINDOWS as readonly string[]).includes(raw ?? '') ? (raw as AnalyticsWindow) : 'month';
    const set = useCallback(
        (w: AnalyticsWindow) =>
            setParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    if (w === 'month') next.delete('window');
                    else next.set('window', w);
                    return next;
                },
                { replace: true },
            ),
        [setParams],
    );
    return [window, set];
}

function viewerTz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/**
 * A headline number with its definition one tap away (the info button is a
 * real button, so the tooltip reaches keyboard and touch too).
 */
function StatTile({ label, value, definition }: { label: string; value: ReactNode; definition: string }) {
    return (
        <Box
            sx={{
                background: ATLAS_PALETTE.white,
                border: `1px solid ${ATLAS_PALETTE.slate10}`,
                borderRadius: '12px',
                p: { xs: 2, md: 2.5 },
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                <Typography sx={{ fontSize: 12.5, color: ATLAS_PALETTE.slate60, fontWeight: 500, lineHeight: 1.35 }}>
                    {label}
                </Typography>
                <Tooltip title={definition} enterTouchDelay={0} leaveTouchDelay={4000}>
                    <Box
                        component="button"
                        type="button"
                        aria-label={`How ${label} is measured`}
                        sx={{
                            all: 'unset',
                            cursor: 'help',
                            color: ATLAS_PALETTE.slate40,
                            display: 'inline-flex',
                            borderRadius: '50%',
                            flexShrink: 0,
                            '&:focus-visible': { outline: `2px solid ${ATLAS_PALETTE.brandBlue}`, outlineOffset: 2 },
                        }}
                    >
                        <Box component="span" className="material-symbols-rounded" aria-hidden="true" sx={{ fontSize: 16 }}>
                            info
                        </Box>
                    </Box>
                </Tooltip>
            </Box>
            <Typography
                sx={{
                    fontFamily: TYPOGRAPHY.fontFamilyMono,
                    fontSize: { xs: 20, md: 24 },
                    fontWeight: 600,
                    color: ATLAS_PALETTE.slate,
                    lineHeight: 1.15,
                    fontVariantNumeric: 'tabular-nums',
                    overflowWrap: 'anywhere',
                }}
            >
                {value}
            </Typography>
        </Box>
    );
}

const TILE_GRID_SX = {
    display: 'grid',
    gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
    gap: { xs: 1.5, md: 2 },
} as const;

function PageSkeleton() {
    return (
        <Box sx={{ display: 'grid', gap: 2 }} aria-busy="true" aria-label="Loading">
            <Box sx={TILE_GRID_SX}>
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} variant="rounded" height={88} />
                ))}
            </Box>
            <Skeleton variant="rounded" height={380} />
        </Box>
    );
}

function Body({ window }: { window: AnalyticsWindow }) {
    const { data: a, error } = useAnalytics(window);
    if (error) return <Alert severity="error">Could not load analytics: {(error as Error).message}</Alert>;
    if (!a) return <PageSkeleton />;

    const unit = a.period.bucket === 'week' ? 'week' : 'day';
    const series = a.series.map((b) => ({ label: bucketLabel(b.bucket), tasks: b.tasks_shipped, spend: b.spend_usd }));

    return (
        <Box sx={{ display: 'grid', gap: { xs: 2, md: 3 } }}>
            <Box sx={TILE_GRID_SX}>
                <StatTile
                    label="Tasks shipped"
                    value={a.tasks_shipped.toLocaleString()}
                    definition="Tasks whose first move into Done falls in this window. Sub-tasks and agent-test Tasks are left out."
                />
                <StatTile
                    label="PRs merged"
                    value={a.prs_merged.toLocaleString()}
                    definition="PRs opened by Task runs that started in this window, merged as last checked on GitHub. Agent tests are left out."
                />
                <StatTile
                    label="Median cycle time"
                    value={formatSpan(a.cycle_p50_s)}
                    definition="Cycle time = a Task's first move into In progress → its first move into Done. The median over the Tasks shipped in this window."
                />
                <StatTile
                    label="Spend"
                    value={formatCostUsd(a.spend_usd)}
                    definition="Completed agent runs plus closed terminal sessions in this window."
                />
            </Box>

            <Box
                sx={{
                    background: ATLAS_PALETTE.white,
                    border: `1px solid ${ATLAS_PALETTE.slate10}`,
                    borderRadius: '14px',
                    p: { xs: 2.5, md: 4 },
                    minWidth: 0,
                }}
            >
                <Box sx={{ mb: 2.5 }}>
                    <Typography component="h2" sx={{ fontSize: 16, fontWeight: 700, color: ATLAS_PALETTE.slate, lineHeight: 1.3 }}>
                        Shipped and spent, per {unit}
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, color: ATLAS_PALETTE.slate60, mt: 0.5, lineHeight: 1.5, maxWidth: 640 }}>
                        Two charts on one time axis, each on its own scale: Tasks first moved into Done, then what agent runs and
                        terminal sessions cost in the same {unit}.
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: ATLAS_PALETTE.slate60, mb: 0.5 }}>Tasks shipped</Typography>
                <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={series} syncId="analytics" margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                        <CartesianGrid stroke={CHART_PALETTE.grid} vertical={false} />
                        <XAxis dataKey="label" hide />
                        <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
                        <ChartTooltip {...TOOLTIP_STYLE} />
                        <Bar dataKey="tasks" name="Tasks shipped" fill={CHART_PALETTE.task} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    </BarChart>
                </ResponsiveContainer>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: ATLAS_PALETTE.slate60, mb: 0.5, mt: 2 }}>Spend</Typography>
                <ResponsiveContainer width="100%" height={190}>
                    <BarChart data={series} syncId="analytics" margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                        <CartesianGrid stroke={CHART_PALETTE.grid} vertical={false} />
                        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: CHART_PALETTE.rail }} tickLine={false} minTickGap={16} />
                        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={usdTick} />
                        <ChartTooltip {...TOOLTIP_STYLE} formatter={usdTooltip} />
                        <Bar dataKey="spend" name="Spend" fill={CHART_PALETTE.cost} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    </BarChart>
                </ResponsiveContainer>
            </Box>
        </Box>
    );
}

export function Analytics() {
    useSetPageTitle('Analytics');
    const [window, setWindow] = useWindowParam();
    const tz = viewerTz();
    const span =
        window === 'month'
            ? new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' })
            : `the last ${WINDOW_LABEL[window]}`;

    return (
        <Box sx={{ px: { xs: 2, sm: 3, md: 8 }, py: { xs: 3, md: 4 }, minWidth: 0 }}>
            <PageHeader
                icon="analytics"
                title="Analytics"
                subtitle={`What shipped, how fast and what it cost, for ${span}. Times are in ${tz}.`}
                actions={
                    <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={window}
                        aria-label="Window"
                        // Phones: on its own line under the title, the four windows share it evenly.
                        sx={{ width: { xs: '100%', sm: 'auto' }, '& > *': { flex: { xs: 1, sm: 'none' } } }}
                        onChange={(_e, v: AnalyticsWindow | null) => {
                            if (v !== null) setWindow(v);
                        }}
                    >
                        {ANALYTICS_WINDOWS.map((w) => (
                            <ToggleButton key={w} value={w} sx={{ textTransform: 'none', px: { xs: 1.25, sm: 2 }, whiteSpace: 'nowrap' }}>
                                {WINDOW_LABEL[w]}
                            </ToggleButton>
                        ))}
                    </ToggleButtonGroup>
                }
            />
            <Body window={window} />
        </Box>
    );
}
