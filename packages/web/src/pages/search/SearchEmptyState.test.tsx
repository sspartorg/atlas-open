import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/renderWithProviders.js';
import { EMPTY_FILTERS } from './searchViewModel.js';
import { SearchEmptyState } from './SearchEmptyState.js';

describe('SearchEmptyState', () => {
    it('shows the message with no actions when no filter can be dropped', () => {
        renderWithProviders(
            <SearchEmptyState
                filters={EMPTY_FILTERS}
                queryText={null}
                onDropStatus={vi.fn()}
                onDropProject={vi.fn()}
            />
        );
        expect(screen.getByText(/No Items Match/)).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders Drop status and Drop project when active', () => {
        renderWithProviders(
            <SearchEmptyState
                filters={{ ...EMPTY_FILTERS, status: 'ready', projectIds: ['p1'] }}
                queryText="status = ready"
                onDropStatus={vi.fn()}
                onDropProject={vi.fn()}
            />
        );
        expect(screen.getByRole('button', { name: /Drop the Status/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Different Project/ })).toBeInTheDocument();
    });

    it('shows queryText code block when queryText is provided (supplemental truthy branch)', () => {
        renderWithProviders(
            <SearchEmptyState
                filters={EMPTY_FILTERS}
                queryText="type = task"
                onDropStatus={vi.fn()}
                onDropProject={vi.fn()}
            />
        );
        expect(screen.getByText('type = task')).toBeInTheDocument();
    });

    it('fires onDropStatus when Drop status button is clicked', () => {
        const onDropStatus = vi.fn();
        renderWithProviders(
            <SearchEmptyState
                filters={{ ...EMPTY_FILTERS, status: 'in_progress' }}
                queryText={null}
                onDropStatus={onDropStatus}
                onDropProject={vi.fn()}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: /Drop the Status/ }));
        expect(onDropStatus).toHaveBeenCalledOnce();
    });

    it('fires onDropProject when Try Different Project button is clicked', () => {
        const onDropProject = vi.fn();
        renderWithProviders(
            <SearchEmptyState
                filters={{ ...EMPTY_FILTERS, projectIds: ['proj-abc'] }}
                queryText={null}
                onDropStatus={vi.fn()}
                onDropProject={onDropProject}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: /Different Project/ }));
        expect(onDropProject).toHaveBeenCalledOnce();
    });

    it('supplemental is undefined (falsy) when queryText is null (L47 false branch)', () => {
        // queryText=null → supplemental=undefined → no code block rendered
        renderWithProviders(
            <SearchEmptyState
                filters={EMPTY_FILTERS}
                queryText={null}
                onDropStatus={vi.fn()}
                onDropProject={vi.fn()}
            />
        );
        // The queryText code block should NOT be present
        expect(screen.queryByRole('code')).toBeNull();
    });
});
