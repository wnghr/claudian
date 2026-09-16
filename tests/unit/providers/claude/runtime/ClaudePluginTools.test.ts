import type { PaperFieldEditPort } from '@/core/note/PaperFieldEdit';
import type { PaperNoteWritePort } from '@/core/note/PaperNoteWrite';
import type { PaperReadPort } from '@/core/paper/PaperRead';
import type { PaperSearchPort } from '@/core/search/PaperSearch';
import type { PluginToolContext } from '@/core/tools/PluginToolContext';
import { PLUGIN_TOOL_SPECS } from '@/core/tools/pluginToolSpecs';
import { createClaudePluginToolServers } from '@/providers/claude/runtime/ClaudePluginTools';

interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function exposedTools(server: unknown): ExposedTool[] {
  return (server as { __options: { tools: ExposedTool[] } }).__options.tools;
}

function createContext(): { context: PluginToolContext } {
  return {
    context: {
      confirmToolAction: jest.fn().mockResolvedValue(true),
      fields: { setPaperFields: jest.fn() } as unknown as PaperFieldEditPort,
      getLinkedPaperPath: () => null,
      reader: { readPaper: jest.fn() } as unknown as PaperReadPort,
      search: { searchPapers: jest.fn() } as unknown as PaperSearchPort,
      writer: { appendToNote: jest.fn() } as unknown as PaperNoteWritePort,
    },
  };
}

describe('createClaudePluginToolServers', () => {
  it('groups every catalog tool into one in-process server per namespace', () => {
    const servers = createClaudePluginToolServers(createContext().context);

    expect(Object.keys(servers)).toEqual(['claudian']);
    const tools = exposedTools(servers.claudian);
    expect(tools.map(tool => tool.name)).toEqual(PLUGIN_TOOL_SPECS.map(spec => spec.name));

    for (const tool of tools) {
      const spec = PLUGIN_TOOL_SPECS.find(candidate => candidate.name === tool.name);
      expect(tool.description).toBe(spec?.description);
      // The derived zod shape is what the SDK turns into the tool's JSON schema.
      expect(Object.keys(tool.inputSchema)).toEqual(spec?.fields.map(field => field.name));
    }
  });

  it('does not invoke a write tool when plugin confirmation is denied', async () => {
    const fake = createContext();
    const confirmToolAction = (fake.context as unknown as {
      confirmToolAction: jest.Mock;
    }).confirmToolAction;
    confirmToolAction.mockResolvedValue(false);
    const servers = createClaudePluginToolServers(fake.context);
    const writeNote = exposedTools(servers.claudian).find(tool => tool.name === 'write_note');

    await expect(writeNote?.handler({
      content: '这段内容不应写入',
      target: 'current',
    })).rejects.toThrow('User denied claudian.write_note');
  });
});
