import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { EmptyState } from '../../components/EmptyState.js';
import { ATLAS_PALETTE } from '../../theme/tokens.js';
import type { FilterState } from './searchViewModel.js';

const MONO = '"JetBrains Mono", monospace';

interface Props {
    filters: FilterState;
    queryText: string | null;
    onDropStatus: () => void;
    onDropProject: () => void;
}

export function SearchEmptyState({ filters, queryText, onDropStatus, onDropProject }: Props) {
    return (
        <EmptyState
            icon={
                <Box
                    component="span"
                    className="material-symbols-rounded"
                    aria-hidden="true"
                    sx={{ fontSize: 28, color: ATLAS_PALETTE.slate60 }}
                >
                    travel_explore
                </Box>
            }
            title="No Items Match"
            description="The query parses cleanly but no tasks, sub-tasks, prompts, or conversations match."
            supplemental={
                queryText ? (
                    <Box
                        sx={{
                            display: 'inline-block',
                            background: ATLAS_PALETTE.cloud,
                            border: `1px solid ${ATLAS_PALETTE.brandBlue}30`,
                            borderRadius: '8px',
                            px: 2.5,
                            py: 1.5,
                        }}
                    >
                        <Typography
                            component="code"
                            sx={{ fontFamily: MONO, fontSize: 12, color: ATLAS_PALETTE.slate }}
                        >
                            {queryText}
                        </Typography>
                    </Box>
                ) : undefined
            }
            actions={
                filters.status !== 'any' || filters.projectIds.length > 0 ? (
                    <>
                        {filters.status !== 'any' ? (
                            <Button
                                variant="outlined"
                                size="small"
                                onClick={onDropStatus}
                                startIcon={
                                    <Box
                                        component="span"
                                        className="material-symbols-rounded"
                                        aria-hidden="true"
                                        sx={{ fontSize: 16 }}
                                    >
                                        filter_alt_off
                                    </Box>
                                }
                                sx={{ textTransform: 'none', fontSize: 12.5 }}
                            >
                                Drop the Status Filter
                            </Button>
                        ) : null}
                        {filters.projectIds.length > 0 ? (
                            <Button
                                variant="outlined"
                                size="small"
                                onClick={onDropProject}
                                startIcon={
                                    <Box
                                        component="span"
                                        className="material-symbols-rounded"
                                        aria-hidden="true"
                                        sx={{ fontSize: 16 }}
                                    >
                                        swap_horiz
                                    </Box>
                                }
                                sx={{ textTransform: 'none', fontSize: 12.5 }}
                            >
                                Try a Different Project
                            </Button>
                        ) : null}
                    </>
                ) : undefined
            }
        />
    );
}
