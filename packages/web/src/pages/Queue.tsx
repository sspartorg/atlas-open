import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { IQueueEntry, IScheduledAgent, QueueBlockedReason } from '@atlas/shared';
import { useQueue, useStopQueueEntry } from '../hooks/useQueue.js';
import { useNow } from '../hooks/useNow.js';
import { useSetPageTitle } from '../components/shell/index.js';
import { PageHeader } from '../components/PageHeader.js';
import { AgentChip } from '../components/AgentChip.js';
import { FormSection } from '../components/FormSection.js';
import { ATLAS_PALETTE, TYPOGRAPHY } from '../theme/tokens.js';
import { formatAbsolute, formatSpan } from '../utils/time.js';

const BLOCKED_LABEL: Record<QueueBlockedReason, string> = {
    repo_busy: 'Repo busy',
    dependency: 'Waiting on a dependency',
    awaiting_schedule: 'Waits for schedule',
};

const MONO_SX = { fontFamily: TYPOGRAPHY.fontFamilyMono, fontSize: 12, color: ATLAS_PALETTE.slate60 } as const;

function entryPath(e: IQueueEntry): string {
    return e.kind === 'task' ? `/tasks/${e.id}` : `/agents/${e.agent_id}/runs/${e.run_id ?? e.id}`;
}

function Row({ children }: { children: ReactNode }) {
    return (
        <Box
            component="li"
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 2,
                py: 1.5,
                borderTop: `1px solid ${ATLAS_PALETTE.slate08}`,
                '&:first-of-type': { borderTop: 'none' },
            }}
        >
            {children}
        </Box>
    );
}

function List({ children }: { children: ReactNode }) {
    return (
        <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {children}
        </Box>
    );
}

function Empty({ children }: { children: ReactNode }) {
    return <Typography sx={{ fontSize: 13, color: ATLAS_PALETTE.slate60 }}>{children}</Typography>;
}

function EntryTitle({ entry }: { entry: IQueueEntry }) {
    return (
        <Link component={RouterLink} to={entryPath(entry)} sx={{ fontSize: 13.5, fontWeight: 500, flex: 1, minWidth: 0 }}>
            {entry.title}
        </Link>
    );
}

function agentOf(e: Pick<IQueueEntry, 'agent_name' | 'accent_color'>) {
    return { name: e.agent_name, accent_color: e.accent_color };
}

export function Queue() {
    useSetPageTitle('Queue');
    const { data, isLoading, error } = useQueue();
    const stop = useStopQueueEntry();
    const now = useNow(30_000);

    return (
        <Box sx={{ px: { xs: 3, md: 8 }, pt: 4, pb: 4 }}>
            <PageHeader
                icon="queue"
                title="Queue"
                subtitle="One agent runs at a time. Everything else waits here in the order it will start."
            />
            {error ? (
                <Alert severity="error">Could not load the queue.</Alert>
            ) : isLoading || !data ? (
                <Skeleton variant="rounded" height={160} />
            ) : (
                <>
                    <FormSection label={`Running now · ${data.running.length} / ${data.slots}`}>
                        {data.running.length === 0 ? (
                            <Empty>Nothing is running.</Empty>
                        ) : (
                            <List>
                                {data.running.map((e) => (
                                    <Row key={`${e.kind}-${e.id}`}>
                                        <AgentChip agent={agentOf(e)} size="sm" />
                                        <EntryTitle entry={e} />
                                        <Typography sx={MONO_SX}>
                                            {e.since ? formatSpan((now - new Date(e.since).getTime()) / 1000) : '—'}
                                        </Typography>
                                        <Button
                                            size="small"
                                            variant="outlined"
                                            color="error"
                                            disabled={!e.run_id || stop.isPending}
                                            onClick={() => stop.mutate(e)}
                                        >
                                            Stop
                                        </Button>
                                    </Row>
                                ))}
                            </List>
                        )}
                    </FormSection>

                    <FormSection label={`Waiting · ${data.waiting.length}`}>
                        {data.waiting.length === 0 ? (
                            <Empty>Nothing is waiting.</Empty>
                        ) : (
                            <List>
                                {data.waiting.map((e, i) => (
                                    <Row key={`${e.kind}-${e.id}`}>
                                        <Typography sx={{ ...MONO_SX, minWidth: 24 }}>{i + 1}</Typography>
                                        <AgentChip agent={agentOf(e)} size="sm" />
                                        <EntryTitle entry={e} />
                                        {e.blocked_reason && <Chip size="small" label={BLOCKED_LABEL[e.blocked_reason]} />}
                                        {e.kind === 'agent_run' && (
                                            <Button
                                                size="small"
                                                variant="outlined"
                                                disabled={stop.isPending}
                                                onClick={() => stop.mutate({ kind: e.kind, run_id: e.run_id ?? e.id })}
                                            >
                                                Cancel
                                            </Button>
                                        )}
                                    </Row>
                                ))}
                            </List>
                        )}
                    </FormSection>

                    <FormSection label={`Scheduled · ${data.scheduled.length}`}>
                        {data.scheduled.length === 0 ? (
                            <Empty>No agent runs on a schedule. Turn one on from an agent&apos;s Overview.</Empty>
                        ) : (
                            <List>
                                {data.scheduled.map((a) => (
                                    <ScheduledRow key={a.agent_id} agent={a} />
                                ))}
                            </List>
                        )}
                    </FormSection>
                </>
            )}
        </Box>
    );
}

function ScheduledRow({ agent }: { agent: IScheduledAgent }) {
    return (
        <Row>
            <Link component={RouterLink} to={`/agents/${agent.agent_id}`} underline="none" sx={{ flex: 1, minWidth: 0 }}>
                <AgentChip agent={agentOf(agent)} size="sm" />
            </Link>
            <Typography sx={MONO_SX}>{agent.schedule_cron_expression}</Typography>
            <Typography sx={{ fontSize: 12, color: ATLAS_PALETTE.slate60 }}>
                Next: {formatAbsolute(agent.schedule_next_run_at)}
            </Typography>
            {agent.schedule_due_at && <Chip size="small" color="warning" label="Due" />}
            {!agent.requires_item && <Chip size="small" label="No item" />}
        </Row>
    );
}
