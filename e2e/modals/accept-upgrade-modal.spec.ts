import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';
import { one, sql } from '../helpers/db.js';

// The upgrade banner on Agent Detail shows when the catalog version is greater
// than agents.marketplace_pulled_version. The seed installs agent-solo at the
// catalog version, so lower its pulled version for this file and restore it
// afterwards (flows/marketplace-upgrade.spec.ts expects them equal).
// We never accept or dismiss — Cancel only.

let pulled = '';

test.describe('AcceptUpgradeModal', () => {
    test.beforeAll(() => {
        pulled = one(`SELECT marketplace_pulled_version FROM agents WHERE id = 'agent-solo'`);
        expect(pulled).toMatch(/^\d+$/);
        sql(`UPDATE agents SET marketplace_pulled_version = ${Number(pulled) - 1} WHERE id = 'agent-solo'`);
    });

    test.afterAll(() => {
        sql(`UPDATE agents SET marketplace_pulled_version = ${pulled} WHERE id = 'agent-solo'`);
    });

    test('Review upgrade opens the upgrade modal and Cancel closes it', async ({ page }) => {
        await goto(page, '/agents/agent-solo');
        await expect(page.getByText('Marketplace upgrade available')).toBeVisible();
        await expect(page.getByText(`v${Number(pulled) - 1} → v${pulled}`, { exact: false })).toBeVisible();

        await page.getByRole('button', { name: 'Review upgrade' }).click();
        const dialog = page.getByRole('dialog', { name: 'Review marketplace upgrade' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Dismiss upgrade' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        // Cancel changes nothing: the banner is still there.
        await expect(page.getByText('Marketplace upgrade available')).toBeVisible();
        expect(one(`SELECT marketplace_pulled_version FROM agents WHERE id = 'agent-solo'`)).toBe(String(Number(pulled) - 1));
    });
});
