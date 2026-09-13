import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from '@anthropic-ai/claude-agent-sdk';

import type { PluginToolContext } from '../../../core/tools/PluginToolContext';
import { PLUGIN_TOOL_SPECS } from '../../../core/tools/pluginToolSpecs';
import type { ErasedTool } from '../../../core/tools/ToolSpec';
import { toClaudeToolShape } from './claudeToolShape';

/**
 * One in-process MCP server per tool namespace, exposing every plugin tool.
 *
 * Adding a capability to the catalog is enough: nothing in this adapter names a
 * specific tool, so the Claude and Codex surfaces cannot drift apart.
 */
export function createClaudePluginToolServers(
  context: PluginToolContext,
): Record<string, McpSdkServerConfigWithInstance> {
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};

  for (const namespace of listNamespaces()) {
    const tools = PLUGIN_TOOL_SPECS.filter(spec => spec.namespace === namespace);
    servers[namespace] = createSdkMcpServer({
      name: namespace,
      version: String(Math.max(...tools.map(spec => spec.version))),
      instructions: tools[0].namespaceDescription,
      tools: tools.map(spec => toClaudeTool(spec, context)),
    });
  }

  return servers;
}

function listNamespaces(): readonly string[] {
  return [...new Set(PLUGIN_TOOL_SPECS.map(spec => spec.namespace))].sort();
}

function toClaudeTool(spec: ErasedTool, context: PluginToolContext) {
  return tool(
    spec.name,
    spec.description,
    toClaudeToolShape(spec.fields),
    async input => ({
      content: [{
        type: 'text',
        text: await spec.invoke(context, input),
      }],
    }),
    {
      alwaysLoad: true,
      annotations: { readOnlyHint: spec.executionClass === 'read' },
    },
  );
}
