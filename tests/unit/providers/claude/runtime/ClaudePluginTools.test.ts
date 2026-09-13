import type { PaperLibraryPort } from '@/core/library/PaperLibrary';
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

function createContext(): { context: PluginToolContext; listPapers: jest.Mock } {
  const listPapers = jest.fn().mockResolvedValue([]);
  return {
    context: {
      fields: { setPaperFields: jest.fn() } as unknown as PaperFieldEditPort,
      getLinkedPdfPath: () => null,
      library: { citePaper: jest.fn(), listPapers } as unknown as PaperLibraryPort,
      reader: { readPaper: jest.fn() } as unknown as PaperReadPort,
      search: { searchPapers: jest.fn() } as unknown as PaperSearchPort,
      writer: { appendToNote: jest.fn() } as unknown as PaperNoteWritePort,
    },
    listPapers,
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

  it('runs a tool through the shared context', async () => {
    const fake = createContext();
    fake.listPapers.mockResolvedValue([{
      cache: 'missing',
      cardPath: null,
      citekey: 'guotopological2026',
      domain: null,
      pages: null,
      parsedAt: null,
      pdfPath: null,
      status: null,
      subfield: null,
      title: 'Topological robustness',
      year: 2026,
    }]);
    const servers = createClaudePluginToolServers(fake.context);
    const browse = exposedTools(servers.claudian).find(tool => tool.name === 'browse');

    await expect(browse?.handler({})).resolves.toEqual({
      content: [expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('guotopological2026 | 2026'),
      })],
    });
    expect(fake.listPapers).toHaveBeenCalledWith({});
  });

  it('surfaces a port failure as a tool error', async () => {
    const fake = createContext();
    fake.listPapers.mockRejectedValue(new Error('vault unavailable'));
    const servers = createClaudePluginToolServers(fake.context);
    const browse = exposedTools(servers.claudian).find(tool => tool.name === 'browse');

    await expect(browse?.handler({})).rejects.toThrow('vault unavailable');
  });
});
