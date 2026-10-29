import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

    // A redirected native stderr line is a terminating error under the script's
    // ErrorActionPreference = Stop, so every redirected `& exe` must run in Invoke-Native.
    it('every native command with a redirection runs through Invoke-Native', () => {
        const out = ps(`
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$null)
$ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] -and $args[0].InvocationOperator -eq 'Ampersand' -and $args[0].Redirections.Count -gt 0 }, $true) |
    Where-Object {
        $p = $_.Parent
        while ($p -and -not ($p -is [System.Management.Automation.Language.CommandAst] -and $p.GetCommandName() -eq 'Invoke-Native')) { $p = $p.Parent }
        -not $p
    } | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Extent.Text)" }`);
        expect(out).toBe('');
    });

    it('Get-ToolVersion reads stdout even when the tool also writes to stderr', () => {
        expect(ps(`${LOAD}; Get-ToolVersion -Command node -Arguments @('-e', "console.error('Package extraction took 5s'); console.log('v9.9.9')")`)).toBe('v9.9.9');
    });

    it('registers the MCP server in a config file that does not exist yet', () => {
        const dir = mkdtempSync(join(tmpdir(), 'atlas-ps1-'));
        const file = join(dir, 'mcp-config.json');
        ps(`${LOAD}; Ensure-McpServerDefinitions -Path '${file}' -ContainerName 'mcpServers' -DesiredServers @{ atlas = @{ type = 'http'; url = 'http://127.0.0.1:4600/mcp' } } -DisplayName 'Copilot' | Out-Null`);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { atlas: { type: 'http', url: 'http://127.0.0.1:4600/mcp' } } });
    });

    it('the optional-install prompt answers its default under -NonInteractive', () => {
        expect(ps(`${LOAD}; $NonInteractive = $true; Prompt-OptionalInstall -DisplayName 'GitHub Copilot CLI' -ExtraContext 'x'`)).toMatch(/True$/);
    });
});
