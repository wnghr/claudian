import type { PaperCitation, PaperLibraryPort } from '@/core/library/PaperLibrary';
import type {
  PaperFieldEditPort,
  PaperFieldEditResult,
} from '@/core/note/PaperFieldEdit';
import type {
  PaperNoteWritePort,
  PaperNoteWriteResult,
} from '@/core/note/PaperNoteWrite';
import type { PaperReadPort } from '@/core/paper/PaperRead';
import type { PaperSearchPort, PaperSearchResult } from '@/core/search/PaperSearch';
import type { PluginToolContext } from '@/core/tools/PluginToolContext';
import { PLUGIN_TOOL_SPECS } from '@/core/tools/pluginToolSpecs';
import type { CodexDynamicToolRegistration } from '@/providers/codex/runtime/CodexDynamicToolRegistry';
import { createCodexPluginTools } from '@/providers/codex/runtime/CodexPluginTools';

const CITATION: PaperCitation = {
  authors: [{ family: 'Asilehan', given: 'Zhawure' }],
  citekey: 'asilehanlightdriven2025',
  doi: '10.1038/s41467-025-56263-5',
  issue: '1',
  pages: '1148',
  title: 'Light-driven dancing of nematic colloids',
  url: 'https://www.nature.com/articles/s41467-025-56263-5',
  venue: 'Nature Communications',
  volume: '16',
  year: 2025,
};

const SEARCH_RESULT: PaperSearchResult = {
  degraded: null,
  hits: [{
    body: 'Focused body about nematic colloids.',
    heading: '2 > Methods',
    kind: 'md',
    locator: 'p.5',
    path: '论文/MD/current/current.paged.md',
    score: 31.5,
    snippet: '…nematic colloids…',
  }],
  index: { chunks: 12, embedded: 12, files: 2 },
  mode: 'hybrid',
  query: 'nematic colloids',
};

interface FakeContext {
  readonly appendToNote: jest.Mock;
  readonly citePaper: jest.Mock;
  readonly context: PluginToolContext;
  readonly listPapers: jest.Mock;
  readonly readPaper: jest.Mock;
  readonly searchPapers: jest.Mock;
  readonly setPaperFields: jest.Mock;
}

function createFakeContext(): FakeContext {
  const readPaper = jest.fn().mockResolvedValue({
    cachePath: '论文/MD/current/current.paged.md',
    content: '<!-- p.2 -->\nFocused body',
    selection: 'p.2',
    sourcePath: '论文/PDF/current.pdf',
    truncated: false,
  });
  const listPapers = jest.fn().mockResolvedValue([{
    cache: 'ready',
    cardPath: '论文/卡片/Current.md',
    citekey: 'current',
    domain: '液晶与软物质',
    pages: 13,
    parsedAt: '2026-09-12T22:30:52+08:00',
    pdfPath: '论文/PDF/current.pdf',
    status: 'unread',
    subfield: '液晶斯格明子',
    title: 'Current paper',
    year: 2025,
  }]);
  const citePaper = jest.fn().mockResolvedValue(CITATION);
  const searchPapers = jest.fn().mockResolvedValue(SEARCH_RESULT);
  const appendToNote = jest.fn().mockResolvedValue({
    action: 'appended',
    link: '[[论文/卡片/Current]]',
    location: '§ 讨论与理解（L12 起）',
    path: '论文/卡片/Current.md',
  } satisfies PaperNoteWriteResult);
  const setPaperFields = jest.fn().mockResolvedValue({
    action: 'updated',
    changed: [{ from: 'unread', key: 'status', to: 'read' }],
    link: '[[论文/卡片/Current]]',
    path: '论文/卡片/Current.md',
    unchanged: [],
  } satisfies PaperFieldEditResult);

  return {
    appendToNote,
    citePaper,
    context: {
      fields: { setPaperFields } as unknown as PaperFieldEditPort,
      getLinkedPdfPath: () => '论文/PDF/current.pdf',
      library: { citePaper, listPapers } as unknown as PaperLibraryPort,
      reader: { readPaper } as unknown as PaperReadPort,
      search: { searchPapers } as unknown as PaperSearchPort,
      writer: { appendToNote } as unknown as PaperNoteWritePort,
    },
    listPapers,
    readPaper,
    searchPapers,
    setPaperFields,
  };
}

function findRegistration(
  registrations: readonly CodexDynamicToolRegistration[],
  name: string,
): CodexDynamicToolRegistration {
  const registration = registrations.find(candidate => candidate.tool.name === name);
  if (!registration) throw new Error(`No Codex registration for tool ${name}`);
  return registration;
}

function callParams(name: string, args: Record<string, unknown>) {
  return {
    arguments: args,
    callId: 'call-1',
    namespace: 'claudian',
    threadId: 'thread-1',
    tool: name,
    turnId: 'turn-1',
  };
}

/**
 * Every tool declares only a slice of `PluginToolContext`, and `defineTool`
 * erases that type, so a tool could ask for a service the adapters never pass
 * and only fail at runtime. Running the whole catalog through one real context
 * is the generic guard against that.
 */
function minimalArguments(spec: (typeof PLUGIN_TOOL_SPECS)[number]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (field.optional === true) continue;
    if (field.type === 'number') args[field.name] = 1;
    else if (field.type === 'boolean') args[field.name] = true;
    else args[field.name] = 'asilehanlightdriven2025';
  }
  return args;
}

describe('createCodexPluginTools', () => {
  it('exposes every catalog tool as a thread-start dynamic tool', () => {
    const registrations = createCodexPluginTools(createFakeContext().context);

    expect(registrations.map(registration => (
      `${registration.namespace?.name}.${registration.tool.name}`
    ))).toEqual(PLUGIN_TOOL_SPECS.map(spec => spec.qualifiedName));

    registrations.forEach((registration, index) => {
      const spec = PLUGIN_TOOL_SPECS[index];
      expect(registration.includeInThreadStart).toBe(true);
      expect(registration.tool.type).toBe('function');
      expect(registration.tool.description).toBe(spec.description);
      expect(registration.tool.inputSchema).toEqual(spec.jsonSchema);
      expect(registration.namespace?.description).toBe(spec.namespaceDescription);
    });
  });

  it('reads the linked PDF through the provider host', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(
      createCodexPluginTools(fake.context),
      'read_pdf',
    );

    await expect(registration.handler(callParams('read_pdf', { pages: '2' })))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining('Selection: p.2'),
        })],
      }));
    expect(fake.readPaper).toHaveBeenCalledWith({
      pages: '2',
      sourcePath: '论文/PDF/current.pdf',
    });
  });

  it('lists the paper library through the browse tool', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'browse');

    await expect(registration.handler(callParams('browse', { query: 'skyrmion' })))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining('current | 2025 | 液晶与软物质 / 液晶斯格明子'),
        })],
      }));
    expect(fake.listPapers).toHaveBeenCalledWith({ query: 'skyrmion' });
  });

  it('formats a reference through the cite tool', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'cite');

    await expect(registration.handler(callParams('cite', { citekey: 'asilehanlightdriven2025' })))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining('Nature Communications, 16(1), 1148'),
        })],
      }));
    expect(fake.citePaper).toHaveBeenCalledWith('asilehanlightdriven2025');
  });

  it('returns citable passages through the search tool', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'search');

    await expect(registration.handler(callParams('search', { query: 'nematic colloids' })))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining(
            '论文/MD/current/current.paged.md  §  2 > Methods  §  p.5',
          ),
        })],
      }));
    expect(fake.searchPapers).toHaveBeenCalledWith({ query: 'nematic colloids' });
  });

  it('appends a dated block through the write_note tool', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'write_note');

    await expect(registration.handler(callParams('write_note', {
      content: '这个耦合机制还没讲清楚',
      target: 'current',
    }))).resolves.toEqual(expect.objectContaining({
      success: true,
      contentItems: [expect.objectContaining({
        text: expect.stringContaining('已写入 论文/卡片/Current.md'),
      })],
    }));
    expect(fake.appendToNote).toHaveBeenCalledWith({
      content: '这个耦合机制还没讲清楚',
      target: 'current',
    });
  });

  it('updates card fields through the set_paper_fields tool', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'set_paper_fields');

    await expect(registration.handler(callParams('set_paper_fields', {
      status: 'read',
      target: 'current',
    }))).resolves.toEqual(expect.objectContaining({
      success: true,
      contentItems: [expect.objectContaining({
        text: expect.stringContaining('已更新 论文/卡片/Current.md'),
      })],
    }));
    expect(fake.setPaperFields).toHaveBeenCalledWith({
      status: 'read',
      target: 'current',
    });
  });

  it('reaches every port it declares through the shared context', async () => {
    const fake = createFakeContext();
    const registrations = createCodexPluginTools(fake.context);

    expect(registrations).toHaveLength(PLUGIN_TOOL_SPECS.length);
    for (const [index, registration] of registrations.entries()) {
      const spec = PLUGIN_TOOL_SPECS[index];
      const args = minimalArguments(spec);
      // set_paper_fields requires at least one whitelisted field besides target.
      if (spec.name === 'set_paper_fields') args.status = 'unread';
      await expect(registration.handler(callParams(spec.name, args)))
        .resolves.toEqual(expect.objectContaining({ success: true }));
    }
  });

  it('reports a failure instead of throwing', async () => {
    const fake = createFakeContext();
    fake.readPaper.mockRejectedValue(new Error('No PDF is linked'));
    const registration = findRegistration(
      createCodexPluginTools(fake.context),
      'read_pdf',
    );

    await expect(registration.handler(callParams('read_pdf', {})))
      .resolves.toEqual(expect.objectContaining({
        success: false,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining('No PDF is linked'),
        })],
      }));
  });

  it('rejects an invalid argument instead of calling the port', async () => {
    const fake = createFakeContext();
    const registration = findRegistration(createCodexPluginTools(fake.context), 'cite');

    await expect(registration.handler(callParams('cite', {})))
      .resolves.toEqual(expect.objectContaining({
        success: false,
        contentItems: [expect.objectContaining({
          text: expect.stringContaining('citekey is required'),
        })],
      }));
    expect(fake.citePaper).not.toHaveBeenCalled();
  });
});
