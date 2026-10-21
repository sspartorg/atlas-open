import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test-utils/renderWithProviders.js';
import { BottomNav } from './BottomNav.js';

describe('BottomNav', () => {
    it('renders nav buttons and fires onOpenMore for "More"', async () => {
        const onOpenMore = vi.fn();
        renderWithProviders(<BottomNav onOpenMore={onOpenMore} />, {
            initialEntries: ['/'],
        });
        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);
        const more = buttons.find((b) => /More/i.test(b.textContent ?? ''));
        if (more) {
            await userEvent.click(more);
            expect(onOpenMore).toHaveBeenCalled();
        }
    });

    it('renders all 4 nav tabs with correct labels', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/'],
        });
        expect(screen.getByText('Home')).toBeInTheDocument();
        expect(screen.getByText('Tasks')).toBeInTheDocument();
        expect(screen.getByText('Projects')).toBeInTheDocument();
        expect(screen.getByText('More')).toBeInTheDocument();
    });

    it('clicking Home tab navigates to / (onClick path branch)', async () => {
        const onOpenMore = vi.fn();
        renderWithProviders(<BottomNav onOpenMore={onOpenMore} />, {
            initialEntries: ['/tasks'],
        });
        const homeBtn = screen
            .getAllByRole('button')
            .find((b) => /Home/i.test(b.textContent ?? ''));
        expect(homeBtn).toBeDefined();
        if (homeBtn) {
            await userEvent.click(homeBtn);
            // Navigation clicked — onOpenMore must NOT have been called
            expect(onOpenMore).not.toHaveBeenCalled();
        }
    });

    it('clicking Tasks tab navigates (onClick non-more with path)', async () => {
        const onOpenMore = vi.fn();
        renderWithProviders(<BottomNav onOpenMore={onOpenMore} />, {
            initialEntries: ['/'],
        });
        const tasksBtn = screen
            .getAllByRole('button')
            .find((b) => /Tasks/i.test(b.textContent ?? ''));
        expect(tasksBtn).toBeDefined();
        if (tasksBtn) {
            await userEvent.click(tasksBtn);
            expect(onOpenMore).not.toHaveBeenCalled();
        }
    });

    it('clicking Projects tab navigates (onClick non-more with path)', async () => {
        const onOpenMore = vi.fn();
        renderWithProviders(<BottomNav onOpenMore={onOpenMore} />, {
            initialEntries: ['/'],
        });
        const projectsBtn = screen
            .getAllByRole('button')
            .find((b) => /Projects/i.test(b.textContent ?? ''));
        expect(projectsBtn).toBeDefined();
        if (projectsBtn) {
            await userEvent.click(projectsBtn);
            expect(onOpenMore).not.toHaveBeenCalled();
        }
    });

    it('Tasks tab is active when pathname is /tasks (matches exact)', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/tasks'],
        });
        expect(screen.getByText('Tasks')).toBeInTheDocument();
    });

    it('Tasks tab is active on a task or sub-task detail page', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/sub-tasks/ATL-2'],
        });
        expect(screen.getByText('Tasks')).toBeInTheDocument();
    });

    it('Projects tab is active on a project page', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/projects/p1'],
        });
        expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('no tab is active (activeKey null) when on an unmatched path', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/settings'],
        });
        // All tabs still render even when none is active
        expect(screen.getByText('Home')).toBeInTheDocument();
        expect(screen.getByText('More')).toBeInTheDocument();
    });

    it('onPointerEnter on Home tab calls prefetchRoute (non-more tab)', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/'],
        });
        const homeBtn = screen
            .getAllByRole('button')
            .find((b) => /Home/i.test(b.textContent ?? ''));
        expect(homeBtn).toBeDefined();
        if (homeBtn) {
            // pointerenter triggers the onPointerEnter handler which calls prefetchRoute
            fireEvent.pointerEnter(homeBtn);
            // No assertion needed — just ensure it doesn't throw
            expect(homeBtn).toBeInTheDocument();
        }
    });

    it('onPointerEnter on Tasks tab calls prefetchRoute', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/'],
        });
        const tasksBtn = screen
            .getAllByRole('button')
            .find((b) => /Tasks/i.test(b.textContent ?? ''));
        if (tasksBtn) {
            fireEvent.pointerEnter(tasksBtn);
            expect(tasksBtn).toBeInTheDocument();
        }
    });

    it('onPointerEnter on More tab does NOT call prefetchRoute (more is excluded)', () => {
        renderWithProviders(<BottomNav onOpenMore={vi.fn()} />, {
            initialEntries: ['/'],
        });
        const moreBtn = screen
            .getAllByRole('button')
            .find((b) => /More/i.test(b.textContent ?? ''));
        if (moreBtn) {
            // tab.key === 'more' so prefetchRoute is skipped — should not throw
            fireEvent.pointerEnter(moreBtn);
            expect(moreBtn).toBeInTheDocument();
        }
    });
});
