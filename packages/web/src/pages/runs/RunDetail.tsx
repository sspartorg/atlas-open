import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import CircularProgress from '@mui/material/CircularProgress';
import type { IWorkflowRunDetail, IWorkflowRunStep } from '@atlas/shared';
import { useResumeWorkflowRun, useStopWorkflowRun, useWorkflowRun } from '../../hooks/useRuns.js';
import { useToast } from '../../hooks/useToast.js';
import { useSetPageTitle } from '../../components/shell/index.js';
import { Breadcrumb } from '../../components/Breadcrumb.js';
import { PAGE_TITLE_SX } from '../../components/PageHeader.js';
import { ATLAS_PALETTE, TYPOGRAPHY } from '../../theme/tokens.js';
import { runStatusPaletteEntry } from '../../theme/runStatusPalette.js';
import { formatCostUsd } from '../../utils/formatCost.js';
import { formatAbsolute, relativeTime } from '../../utils/time.js';
import { RunStatusChip } from './RunStatusChip.js';
import { RunChangesSection } from './RunChangesSection.js';

function durationLabel(start: string | null, end: string | null): string {
    if (!start) return '—';
    const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
    const sec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}


function StepRow({ step, onOpen }: { step: IWorkflowRunStep; onOpen: () => void }) {
    const tone = runStatusPaletteEntry(step.status);
    const note = [step.outcome_summary, step.outcome_reason].filter(Boolean).join(' — ');
    return (
        <Box
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen();
            }}
            data-testid={`wf-step-${step.id}`}
            sx={{
                display: 'grid',
                gridTemplateColumns: '12px minmax(0, 1fr) auto',
                gap: 3,
                px: 4,
                py: 3,
                cursor: 'pointer',
                borderTop: `1px solid ${ATLAS_PALETTE.slate06}`,
                '&:first-of-type': { borderTop: 0 },
                '&:hover': { background: ATLAS_PALETTE.cloud },
            }}
        >
            <Box sx={{ width: 10, height: 10, mt: 1, borderRadius: '50%', background: tone.dot }} />
            <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
                    <Typography
                        sx={{ fontSize: 13.5, fontWeight: 600, color: ATLAS_PALETTE.slate }}
                    >
                        {step.agent_name ?? step.agent_id}
                    </Typography>
                    <Typography sx={{ fontSize: 11, fontWeight: 600, color: tone.fg }}>
                        {step.status.replace('_', ' ')}
                    </Typography>
                    {step.outcome_kind && (
                        <Typography
                            sx={{
                                fontSize: 11,
                                fontFamily: TYPOGRAPHY.fontFamilyMono,
                                color: ATLAS_PALETTE.slate60,
                            }}
                        >
                            outcome: {step.outcome_kind}
                        </Typography>
                    )}
                </Box>
                {note && (
                    <Typography sx={{ fontSize: 12.5, color: ATLAS_PALETTE.slate70, mt: 1 }}>
                        {note}
                    </Typography>
                )}
                <Typography
                    sx={{
                        fontSize: 11,
                        fontFamily: TYPOGRAPHY.fontFamilyMono,
                        color: ATLAS_PALETTE.slate60,
                        mt: 1,
                    }}
                >
                    {[step.cli, step.model, step.effort && `${step.effort} effort`]
                        .filter(Boolean)
                        .join(' · ')}
                </Typography>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
                <Typography
                    sx={{
                        fontSize: 12,
                        fontFamily: TYPOGRAPHY.fontFamilyMono,
                        color: ATLAS_PALETTE.slate,
                    }}
                >
                    {durationLabel(step.started_at, step.completed_at)}
                </Typography>
                <Typography
                    sx={{
                        fontSize: 11,
                        fontFamily: TYPOGRAPHY.fontFamilyMono,
                        color: ATLAS_PALETTE.slate60,
                    }}
                >
                    {formatCostUsd(step.total_cost_usd)}
                </Typography>
            </Box>
        </Box>
    );
}

function RunBanner({ run }: { run: IWorkflowRunDetail }) {
    if (run.status === 'waiting_for_owner') {
        return (
            <Alert severity="warning" sx={{ mb: 3 }}>
                {run.park_reason && (
                    <Box component="span" sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}>
                        {run.park_reason}
                    </Box>
                )}
                The run is waiting for you.{' '}
                {run.item_id ? (
                    <>
                        Reply on the Task to continue —{' '}
                        <Link component={RouterLink} to={`/tasks/${run.item_id}`}>
                            open {run.item_id}
                        </Link>
                        .
                    </>
                ) : (
                    'Resume it when you are ready.'
                )}
            </Alert>
        );
    }
    if (run.status === 'completed' && run.pr_url) {
        return (
            <Alert severity="success" sx={{ mb: 3 }}>
                Delivered —{' '}
                <Link href={run.pr_url} target="_blank" rel="noreferrer">
                    open the pull request
                </Link>
            </Alert>
        );
    }
    if (run.status === 'error') {
        return (
            <Alert severity="error" sx={{ mb: 3 }}>
                The run stopped on an error. Check the agent&apos;s log.
            </Alert>
        );
    }
    return null;
}

function RunView({ run }: { run: IWorkflowRunDetail }) {
    const navigate = useNavigate();
    const toast = useToast();
    const stop = useStopWorkflowRun();
    const resume = useResumeWorkflowRun();
    const live = run.status === 'running' || run.status === 'waiting_for_owner';
    const prs = run.pr_urls.length > 0 ? run.pr_urls : run.pr_url ? [run.pr_url] : [];

    const act = (m: typeof stop, verb: string) =>
        m.mutate(run.id, {
            onError: (err) => toast.show({ message: `Could not ${verb} run`, detail: err.message }),
        });

    return (
        <Box sx={{ px: { xs: 3, md: 8 }, py: 4 }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    justifyContent: 'space-between',
                    gap: 3,
                    flexWrap: 'wrap',
                    mb: 3,
                }}
            >
                <Box sx={{ minWidth: 0 }}>
                    <Breadcrumb
                        items={[
                            run.item_id
                                ? { label: run.item_id, to: `/tasks/${run.item_id}` }
                                : { label: 'Tasks', to: '/tasks' },
                            { label: 'Run' },
                        ]}
                    />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Typography variant="h1" sx={PAGE_TITLE_SX}>
                            {run.item_title ?? 'Project run'}
                        </Typography>
                        <RunStatusChip status={run.status} />
                    </Box>
                    <Typography sx={{ fontSize: 13, color: ATLAS_PALETTE.slate60, mt: 1 }}>
                        <Box component="span" sx={{ fontFamily: TYPOGRAPHY.fontFamilyMono }}>
                            {run.item_id ?? run.id.slice(0, 8)}
                        </Box>
                        {' · started '}
                        <Box component="span" title={formatAbsolute(run.started_at)}>
                            {relativeTime(run.started_at)}
                        </Box>
                        {' · '}
                        <Box component="span" sx={{ fontFamily: TYPOGRAPHY.fontFamilyMono }}>
                            {durationLabel(run.started_at, run.finished_at)} ·{' '}
                            {formatCostUsd(run.total_cost_usd)}
                        </Box>
                        {run.branch && (
                            <>
                                {' · '}
                                <Box component="span" sx={{ fontFamily: TYPOGRAPHY.fontFamilyMono }}>
                                    {run.branch}
                                </Box>
                            </>
                        )}
                    </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    {run.status === 'waiting_for_owner' && (
                        <Button
                            variant="contained"
                            onClick={() => act(resume, 'resume')}
                            disabled={resume.isPending}
                            sx={{
                                textTransform: 'none',
                                fontWeight: 600,
                                bgcolor: ATLAS_PALETTE.green,
                                boxShadow: 'none',
                                '&:hover': { bgcolor: ATLAS_PALETTE.greenDark, boxShadow: 'none' },
                            }}
                        >
                            Resume
                        </Button>
                    )}
                    {live && (
                        <Button
                            variant="outlined"
                            color="error"
                            onClick={() => act(stop, 'stop')}
                            disabled={stop.isPending}
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                        >
                            Stop
                        </Button>
                    )}
                    {prs.map((url, i) => (
                        <Button
                            key={url}
                            variant="outlined"
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                        >
                            {prs.length > 1 ? `Pull request ${i + 1}` : 'Pull request'}
                        </Button>
                    ))}
                </Box>
            </Box>

            <RunBanner run={run} />

            <Box
                component="section"
                aria-label="Steps"
                sx={{
                    border: `1px solid ${ATLAS_PALETTE.slate10}`,
                    borderRadius: '12px',
                    background: ATLAS_PALETTE.white,
                }}
            >
                <Typography
                    variant="overline"
                    sx={{ display: 'block', px: 4, pt: 3, color: ATLAS_PALETTE.slate60 }}
                >
                    Steps · {run.steps.length}
                </Typography>
                {run.steps.length === 0 ? (
                    <Typography sx={{ px: 4, py: 3, fontSize: 13, color: ATLAS_PALETTE.slate60 }}>
                        The agent has not started yet.
                    </Typography>
                ) : (
                    run.steps.map((s) => (
                        <StepRow
                            key={s.id}
                            step={s}
                            onOpen={() => navigate(`/agents/${s.agent_id}/runs/${s.id}`)}
                        />
                    ))
                )}
            </Box>
            <RunChangesSection runId={run.id} />
        </Box>
    );
}

export function RunDetail() {
    const { runId = '' } = useParams<{ runId: string }>();
    const { data: run, isLoading } = useWorkflowRun(runId);
    useSetPageTitle(run?.item_title ?? 'Run', 'Run');

    if (isLoading) {
        return (
            <Box sx={{ p: 8, display: 'flex', justifyContent: 'center' }}>
                <CircularProgress size={32} sx={{ color: ATLAS_PALETTE.brandBlue }} />
            </Box>
        );
    }
    if (!run) {
        return (
            <Box sx={{ px: { xs: 3, md: 8 }, py: 4 }}>
                <Typography sx={{ fontSize: 16, color: ATLAS_PALETTE.slate60 }}>
                    Run not found.
                </Typography>
            </Box>
        );
    }
    return <RunView run={run} />;
}
