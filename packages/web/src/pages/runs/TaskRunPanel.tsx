import { Link as RouterLink } from 'react-router-dom';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import {
    useItemWorkflowRuns,
    useResumeWorkflowRun,
    useStopWorkflowRun,
    useWorkflowRun,
} from '../../hooks/useRuns.js';
import { useToast } from '../../hooks/useToast.js';
import { InfoRow } from '../../components/InfoPanel.js';
import { ATLAS_PALETTE } from '../../theme/tokens.js';
import { LIVE_WORKFLOW_RUN_STATUSES } from '../../theme/workflowRunStatusPalette.js';
import { relativeTime } from '../../utils/time.js';
import { RunStatusChip } from './RunStatusChip.js';

const SMALL_BTN_SX = { textTransform: 'none', fontSize: 12, py: 0, minWidth: 0, whiteSpace: 'nowrap' } as const;

/** The Task's latest run: what its agent is doing, and Stop / Resume. */
export function TaskRunPanel({ taskId }: { taskId: string }) {
    const toast = useToast();
    const { data: runs = [] } = useItemWorkflowRuns(taskId);
    const latest = runs[0];
    const { data: detail } = useWorkflowRun(latest?.id ?? '');
    const stop = useStopWorkflowRun();
    const resume = useResumeWorkflowRun();
    if (!latest) return null;

    const live = LIVE_WORKFLOW_RUN_STATUSES.includes(latest.status);
    const step = detail?.steps[detail.steps.length - 1];
    const prs = latest.pr_urls.length > 0 ? latest.pr_urls : latest.pr_url ? [latest.pr_url] : [];
    const act = (m: typeof stop, verb: string) =>
        m.mutate(latest.id, {
            onError: (err) => toast.show({ message: `Could not ${verb} run`, detail: err.message }),
        });

    return (
        <>
            <InfoRow label="Run">
                <Link
                    component={RouterLink}
                    to={`/runs/${latest.id}`}
                    underline="none"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}
                >
                    <RunStatusChip status={latest.status} />
                    <Typography
                        component="span"
                        sx={{ fontSize: 11.5, color: ATLAS_PALETTE.slate60, whiteSpace: 'nowrap' }}
                    >
                        {relativeTime(latest.started_at)}
                    </Typography>
                </Link>
            </InfoRow>
            {latest.status === 'waiting_for_owner' && latest.park_reason && (
                <InfoRow label="Waiting on you">
                    <Typography sx={{ fontSize: 12, color: ATLAS_PALETTE.slate70 }}>
                        {latest.park_reason}
                    </Typography>
                </InfoRow>
            )}
            {step && (
                <InfoRow label="Agent run">
                    <Link
                        component={RouterLink}
                        to={`/agents/${step.agent_id}/runs/${step.id}`}
                        sx={{ fontSize: 12 }}
                    >
                        {step.agent_name ?? 'Open log'}
                    </Link>
                </InfoRow>
            )}
            {latest.branch && (
                <InfoRow label="Changes">
                    <Link component={RouterLink} to={`/runs/${latest.id}#changes`} sx={{ fontSize: 12 }}>
                        View changes
                    </Link>
                </InfoRow>
            )}
            {prs.map((url, i) => (
                <InfoRow key={url} label={prs.length > 1 ? `Pull request ${i + 1}` : 'Pull request'}>
                    <Link href={url} target="_blank" rel="noreferrer" sx={{ fontSize: 12 }}>
                        Open on GitHub
                    </Link>
                </InfoRow>
            ))}
            {live && (
                <InfoRow label="Actions">
                    {latest.status === 'waiting_for_owner' && (
                        <Button
                            size="small"
                            variant="contained"
                            disabled={resume.isPending}
                            onClick={() => act(resume, 'resume')}
                            sx={{ ...SMALL_BTN_SX, boxShadow: 'none' }}
                        >
                            Resume
                        </Button>
                    )}
                    <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        disabled={stop.isPending}
                        onClick={() => act(stop, 'stop')}
                        sx={SMALL_BTN_SX}
                    >
                        Stop
                    </Button>
                </InfoRow>
            )}
        </>
    );
}
