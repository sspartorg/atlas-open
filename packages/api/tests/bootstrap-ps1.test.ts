import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/bootstrap.ps1, checked by Windows PowerShell 5.1 itself — the shell
// the one-click install runs in. Under `Set-StrictMode -Version Latest` a
// string like "Install $DisplayName?" reads the variable `DisplayName?`, which
// is unset, so the script threw on every machine missing gh or copilot. Found
// by running the installer from a fresh clone.

const SCRIPT = resolve(__dirname, '../../../scripts/bootstrap.ps1');

function ps(command: string): string {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
}

// Every function the script defines, loaded without running its main flow.
const LOAD = `
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$null)
foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression ($f.Extent.Text -replace '^function ', 'function global:')
}`;

describe.runIf(process.platform === 'win32')('bootstrap.ps1 (Windows PowerShell)', () => {
    it('parses, and no variable name swallows a trailing "?"', () => {
        const out = ps(`
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$errs)
$bad = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) |
    Where-Object { $_.VariablePath.UserPath -match '[?]$' } | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Extent.Text)" }
"errors=$($errs.Count)"; $bad`);
        expect(out).toBe('errors=0');
    });

    it('the optional-install prompt answers its default under -NonInteractive', () => {
        expect(ps(`${LOAD}; $NonInteractive = $true; Prompt-OptionalInstall -DisplayName 'GitHub Copilot CLI' -ExtraContext 'x'`)).toMatch(/True$/);
    });
});
