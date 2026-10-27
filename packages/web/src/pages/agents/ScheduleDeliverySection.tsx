import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { IAgent } from '@atlas/shared';
import { useUpdateAgent } from '../../hooks/useAgents.js';
import { useToast } from '../../hooks/useToast.js';
import { FormSection } from '../../components/FormSection.js';
import { SchedulePresetFields } from '../../components/SchedulePresetFields.js';
import { ATLAS_PALETTE, TYPOGRAPHY } from '../../theme/tokens.js';
import { formatAbsolute } from '../../utils/time.js';

type RunConfig = Pick<
    IAgent,
    | 'requires_item'
    | 'git_commit'
    | 'git_push'
    | 'git_open_pr'
    | 'schedule_enabled'
    | 'schedule_preset'
    | 'schedule_time_of_day'
    | 'schedule_weekday'
    | 'schedule_cron_expression'
>;

type DeliveryKey = 'git_commit' | 'git_push' | 'git_open_pr';
type Delivery = Pick<IAgent, DeliveryKey>;

// The API 400s a broken chain (push needs commit, PR needs push), so a toggle
// drags its neighbours along instead of letting the Owner build one.
export function chainDelivery(d: Delivery, key: DeliveryKey, on: boolean): Delivery {
    if (key === 'git_open_pr') {
        return on ? { git_commit: true, git_push: true, git_open_pr: true } : { ...d, git_open_pr: false };
    }
    if (key === 'git_push') {
        return on ? { ...d, git_commit: true, git_push: true } : { ...d, git_push: false, git_open_pr: false };
    }
    return on ? { ...d, git_commit: true } : { git_commit: false, git_push: false, git_open_pr: false };
}

function pick(agent: IAgent): RunConfig {
    return {
        requires_item: agent.requires_item,
        git_commit: agent.git_commit,
        git_push: agent.git_push,
        git_open_pr: agent.git_open_pr,
        schedule_enabled: agent.schedule_enabled,
        schedule_preset: agent.schedule_preset,
        schedule_time_of_day: agent.schedule_time_of_day,
        schedule_weekday: agent.schedule_weekday,
        schedule_cron_expression: agent.schedule_cron_expression,
    };
}

const DELIVERY: Array<{ key: DeliveryKey; label: string }> = [
    { key: 'git_commit', label: 'Commit' },
    { key: 'git_push', label: 'Push' },
    { key: 'git_open_pr', label: 'Open pull request' },
];

const HINT_SX = { fontSize: 12, color: ATLAS_PALETTE.slate60 } as const;

export function ScheduleDeliverySection({ agent }: { agent: IAgent }) {
    const updateAgent = useUpdateAgent();
    const toast = useToast();
    const saved = pick(agent);
    const [f, setF] = useState<RunConfig>(saved);
    const set = (patch: Partial<RunConfig>) => setF((prev) => ({ ...prev, ...patch }));
    const isDirty = (Object.keys(saved) as Array<keyof RunConfig>).some((k) => f[k] !== saved[k]);
    const showTime = f.schedule_preset === 'daily' || f.schedule_preset === 'weekly';

    function handleSave() {
        updateAgent.mutate(
            { id: agent.id, data: f },
            {
                onSuccess: (updated) => {
                    // The server rewrites the cron from the preset; adopt its copy so the form isn't left dirty.
                    setF(pick(updated));
                    toast.show({ message: 'Schedule & delivery saved' });
                },
            }
        );
    }

    return (
        <FormSection label="Schedule & delivery">
            <FormControlLabel
                control={
                    <Switch
                        checked={f.requires_item}
                        onChange={(e) => set({ requires_item: e.target.checked })}
                    />
                }
                label="Works on a Task"
            />
            {!f.requires_item && (
                <Typography sx={HINT_SX}>Runs in a scratch folder; never touches git.</Typography>
            )}

            {f.requires_item && (
                <Box sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', columnGap: 3 }}>
                    {DELIVERY.map(({ key, label }) => (
                        <FormControlLabel
                            key={key}
                            control={
                                <Switch
                                    checked={f[key]}
                                    onChange={(e) => set(chainDelivery(f, key, e.target.checked))}
                                />
                            }
                            label={label}
                        />
                    ))}
                    {!f.git_commit && (
                        <Typography sx={{ ...HINT_SX, width: '100%' }}>
                            Changes stay uncommitted in the Task&apos;s worktree.
                        </Typography>
                    )}
                </Box>
            )}

            <Box sx={{ mt: 2 }}>
                <FormControlLabel
                    control={
                        <Switch
                            checked={f.schedule_enabled}
                            onChange={(e) => set({ schedule_enabled: e.target.checked })}
                        />
                    }
                    label="Run on a schedule"
                />
            </Box>
            {f.schedule_enabled && (
                <Box sx={{ mt: 1.5 }}>
                    <SchedulePresetFields
                        value={{
                            preset: f.schedule_preset,
                            weekday: f.schedule_weekday,
                            cronExpression: f.schedule_cron_expression,
                        }}
                        onChange={(patch) =>
                            set({
                                ...(patch.preset ? { schedule_preset: patch.preset } : {}),
                                ...(patch.weekday !== undefined ? { schedule_weekday: patch.weekday } : {}),
                                ...(patch.cronExpression !== undefined
                                    ? { schedule_cron_expression: patch.cronExpression }
                                    : {}),
                            })
                        }
                    />
                    {showTime && (
                        <TextField
                            label="Time of day"
                            type="time"
                            size="small"
                            value={f.schedule_time_of_day}
                            onChange={(e) => set({ schedule_time_of_day: e.target.value })}
                            sx={{ mb: 2 }}
                        />
                    )}
                    <Typography sx={HINT_SX}>
                        Next run:{' '}
                        <Box component="span" sx={{ fontFamily: TYPOGRAPHY.fontFamilyMono }}>
                            {agent.schedule_next_run_at ? formatAbsolute(agent.schedule_next_run_at) : '—'}
                        </Box>
                    </Typography>
                </Box>
            )}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5, mt: 2 }}>
                {isDirty && (
                    <Button variant="outlined" size="small" onClick={() => setF(saved)}>
                        Discard
                    </Button>
                )}
                <Button
                    variant="contained"
                    size="small"
                    onClick={handleSave}
                    disabled={!isDirty || updateAgent.isPending}
                >
                    {updateAgent.isPending ? 'Saving…' : 'Save schedule & delivery'}
                </Button>
            </Box>
        </FormSection>
    );
}
