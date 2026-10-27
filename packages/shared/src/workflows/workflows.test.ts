import { describe, expect, it } from 'vitest';
import { WORKFLOW_EDGE_KINDS, WORKFLOW_NODE_TYPES, WORKFLOW_RUN_STATUSES } from './index.js';

describe('workflow run vocabulary', () => {
    it('a Task run is start → agent → end, routed by pass/fail', () => {
        expect(WORKFLOW_NODE_TYPES).toEqual(['start', 'agent', 'end']);
        expect(WORKFLOW_EDGE_KINDS).toEqual(['pass', 'fail']);
        expect(WORKFLOW_RUN_STATUSES).toContain('waiting_for_owner');
    });
});
