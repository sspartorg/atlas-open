import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import { ThemeProvider } from '@mui/material/styles';
import { ButtonSpinner } from '../components/ButtonSpinner.js';
import { createAtlasTheme } from './theme.js';

describe('createAtlasTheme', () => {
    it('names every progressbar (axe aria-progressbar-name) unless it brings its own label', () => {
        render(
            <ThemeProvider theme={createAtlasTheme('light')}>
                <CircularProgress />
                <CircularProgress aria-label="Loading repos" />
                <LinearProgress variant="determinate" value={50} />
            </ThemeProvider>,
        );
        expect(screen.getAllByRole('progressbar', { name: 'Loading' })).toHaveLength(2);
        expect(screen.getByRole('progressbar', { name: 'Loading repos' })).toBeTruthy();
    });

    it("keeps a hidden button spinner out of the button's name", () => {
        render(
            <ThemeProvider theme={createAtlasTheme('light')}>
                <Button startIcon={<ButtonSpinner />}>Delete</Button>
            </ThemeProvider>,
        );
        expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });
});
