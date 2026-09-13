/**
 * Every plugin tool lives in one MCP namespace.
 *
 * That namespace becomes a single in-process MCP server on the Claude side and
 * a single dynamic-tool namespace on the Codex side. The description belongs to
 * the namespace rather than to a tool, because the server carries exactly one
 * instruction string; the catalog asserts that all its tools agree on it.
 */
export const PLUGIN_TOOL_NAMESPACE = 'claudian';

export const PLUGIN_TOOL_NAMESPACE_DESCRIPTION =
  'Claudian paper tools: enumerate the vault paper library, cite a paper from the bibliography index, and read the PDF linked to this conversation through its validated Markdown cache.';
