import {
  PLUGIN_TOOL_SPEC_ENTRIES,
  RETIRED_PLUGIN_TOOL_NAMES,
} from './pluginToolSpecEntries';
import { collectTools, type ErasedTool, findToolByActionName } from './ToolSpec';

export { RETIRED_PLUGIN_TOOL_NAMES };

/**
 * The validated plugin tool catalog. Adding a capability means adding one entry
 * to `PLUGIN_TOOL_SPEC_ENTRIES`; both provider adapters read the catalog, so a
 * tool can never exist for one provider only.
 */
export const PLUGIN_TOOL_SPECS: readonly ErasedTool[] = collectTools(
  PLUGIN_TOOL_SPEC_ENTRIES,
);

/** Instruction strings appended to the system prompt by the plugin. */
export const PLUGIN_TOOL_INSTRUCTIONS: readonly string[] = PLUGIN_TOOL_SPECS
  .flatMap(tool => (tool.instructions === null ? [] : [tool.instructions]));

export function findPluginToolByActionName(actionName: string): ErasedTool | null {
  return findToolByActionName(PLUGIN_TOOL_SPECS, actionName);
}

/**
 * Selector-only action pattern used for approval rule matching. Returns null
 * for host tools so the caller can fall back to its own wording.
 */
export function pluginToolActionPattern(
  actionName: string,
  input: Record<string, unknown>,
): string | null {
  const tool = findPluginToolByActionName(actionName);
  if (!tool) return null;
  return tool.describeAction(input) || null;
}

/**
 * Human-readable approval line for a plugin tool, or null when the action does
 * not belong to the plugin (the caller then falls back to the host wording).
 */
export function describePluginToolAction(
  actionName: string,
  input: Record<string, unknown>,
): string | null {
  const tool = findPluginToolByActionName(actionName);
  if (!tool) return null;
  const selection = tool.describeAction(input);
  return selection ? `${tool.actionLabel}: ${selection}` : tool.actionLabel;
}
