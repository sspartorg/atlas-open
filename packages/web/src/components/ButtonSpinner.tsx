import CircularProgress, { type CircularProgressProps } from '@mui/material/CircularProgress';

/**
 * The busy spinner inside a button. aria-hidden: the button already names the
 * action, and an unhidden progressbar would join that name ("Loading Delete").
 */
export function ButtonSpinner(props: CircularProgressProps) {
    return <CircularProgress aria-hidden size={14} color="inherit" {...props} />;
}
