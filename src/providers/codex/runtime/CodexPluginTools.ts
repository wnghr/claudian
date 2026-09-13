import type { PluginToolContext } from '../../../core/tools/PluginToolContext';
import { PLUGIN_TOOL_SPECS } from '../../../core/tools/pluginToolSpecs';
import type { ErasedTool } from '../../../core/tools/ToolSpec';
import type { CodexDynamicToolRegistration } from './CodexDynamicToolRegistry';

/**
 * Every plugin tool as a Codex dynamic tool.
 *
 * Adding a capability to the catalog is enough: nothing in this adapter names a
 * specific tool, so the Codex and Claude surfaces cannot drift apart.
 */
export function createCodexPluginTools(
  context: PluginToolContext,
): readonly CodexDynamicToolRegistration[] {
  return PLUGIN_TOOL_SPECS.map(spec => toCodexTool(spec, context));
}

function toCodexTool(
  spec: ErasedTool,
  context: PluginToolContext,
): CodexDynamicToolRegistration {
  return {
    includeInThreadStart: true,
    namespace: {
      name: spec.namespace,
      description: spec.namespaceDescription,
    },
    tool: {
      type: 'function',
      name: spec.name,
      description: spec.description,
      inputSchema: spec.jsonSchema,
    },
    handler: async params => {
      try {
        const text = await spec.invoke(context, params.arguments);
        return {
          success: true,
          contentItems: [{
            type: 'inputText',
            text,
          }],
        };
      } catch (error) {
        return {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: error instanceof Error ? error.message : String(error),
          }],
        };
      }
    },
  };
}
