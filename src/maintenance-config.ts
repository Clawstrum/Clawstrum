/** Restrict Codex maintenance calls without changing the lead's full-access policy.
 * Read-only is a fallback for built-ins that the pinned runtime may still expose.
 * https://learn.chatgpt.com/docs/config-file/config-reference
 */
export const maintenanceCodexConfig = {
  web_search: 'disabled',
  features: {
    shell_tool: false,
    unified_exec: false,
    multi_agent: false,
    apps: false,
    plugins: false,
    js_repl: false,
    codex_hooks: false,
    hooks: false,
    plugin_hooks: false,
    remote_plugin: false,
    code_mode: false,
    computer_use: false,
    browser_use: false,
    image_generation: false,
    tool_suggest: false,
    tool_search: false,
    memories: false,
    memory_tool: false,
  },
  sandbox_workspace_write: { network_access: false },
};

/** Empty TOML tables merge with inherited settings; disable each resolved server explicitly. */
export function maintenanceCodexOverrides(config: Record<string, unknown>) {
  const disabled = (entries: unknown) =>
    Object.fromEntries(
      Object.keys(entries && typeof entries === 'object' ? entries : {}).map((name) => [
        name,
        { enabled: false },
      ]),
    );
  return {
    ...maintenanceCodexConfig,
    mcp_servers: disabled(config.mcp_servers),
    plugins: disabled(config.plugins),
  };
}
