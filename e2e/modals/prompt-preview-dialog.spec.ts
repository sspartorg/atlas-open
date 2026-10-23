import { test, expect } from '@playwright/test';
import { goto } from '../helpers/nav.js';

// PromptPreviewDialog opens from "Preview prompt" inside RunNowDialog, which
// "Run now" on Agent Detail opens. Preview only compiles the prompt
// (POST /api/agents/:id/compile-prompt — no AI, nothing queued). We never
// press the dialog's own "Run now".

test.describe('PromptPreviewDialog', () => {
    test('Preview prompt compiles and shows the prompt without starting a run', async ({ page }) => {
        await goto(page, '/agents/agent-solo');
        await page.getByRole('button', { name: 'Run now' }).click();
        const runDialog = page.getByRole('dialog', { name: /^Run / });
        await expect(runDialog).toBeVisible();

        const compiled = page.waitForResponse(
            (r) => r.url().endsWith('/api/agents/agent-solo/compile-prompt') && r.request().method() === 'POST',
        );
        await runDialog.getByRole('button', { name: 'Preview prompt' }).click();
        expect((await compiled).status()).toBe(200);

        const preview = page.getByRole('dialog', { name: 'Prompt preview' });
        await expect(preview).toBeVisible();
        await expect(preview.getByText('freedom run · no item')).toBeVisible();
        await expect(preview.getByText(/Nothing was queued or written/)).toBeVisible();

        // Esc closes only the top-most dialog; the Run dialog stays open.
        await page.keyboard.press('Escape');
        await expect(preview).toBeHidden();
        await expect(runDialog).toBeVisible();
        await runDialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(runDialog).toBeHidden();
    });
});
