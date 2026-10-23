const DEFAULT_API_BASE = 'http://127.0.0.1:4301';

export interface IMcpConfig {
    apiBase: string;
    requestTimeoutMs: number;
    /**
     * Shared secret sent as `X-Atlas-Token` on every write request. Empty string
     * means "no token"; the API will reject writes unless its own
     * `ATLAS_MCP_TOKEN` is also empty. Reads (GET) never include the header.
     */
    mcpToken: string;
}

export function loadConfig(): IMcpConfig {
    const apiBase = (process.env['ATLAS_API_BASE'] ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const rawTimeout = process.env['ATLAS_MCP_TIMEOUT_MS'];
    const requestTimeoutMs = rawTimeout ? Math.max(1000, Number(rawTimeout)) : 15_000;
    const mcpToken = process.env['ATLAS_MCP_TOKEN'] ?? '';
    return { apiBase, requestTimeoutMs, mcpToken };
}
