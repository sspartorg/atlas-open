import { useQuery } from '@tanstack/react-query';
import type { AnalyticsWindow } from '@atlas/shared';
import { api } from '../api/api.js';

// The 'analytics' prefix lets one invalidateQueries(['analytics']) refresh every window.
export function useAnalytics(window: AnalyticsWindow) {
    return useQuery({
        queryKey: ['analytics', window],
        queryFn: () => api.analytics.get(window),
        staleTime: 30_000,
    });
}
