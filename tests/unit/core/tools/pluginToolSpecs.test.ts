import { PAPER_READ_TOOL_JSON_SCHEMA } from '@/core/paper/PaperReadTool';
import {
  describePluginToolAction,
  findPluginToolByActionName,
  PLUGIN_TOOL_SPECS,
  pluginToolActionPattern,
  RETIRED_PLUGIN_TOOL_NAMES,
} from '@/core/tools/pluginToolSpecs';
import { collectTools, inspectToolSpecs, toJsonSchema } from '@/core/tools/ToolSpec';

describe('plugin tool catalog', () => {
  it('generates the documented JSON schema from the declarative field list', () => {
    const tool = findPluginToolByActionName('read_pdf');

    expect(tool?.jsonSchema).toEqual(PAPER_READ_TOOL_JSON_SCHEMA);
    expect(tool?.jsonSchema).toEqual({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: expect.stringContaining('Defaults to the PDF linked'),
        },
        pages: { type: 'string', description: expect.stringContaining('page number or range') },
        section: { type: 'string', description: expect.stringContaining('section heading') },
        query: { type: 'string', description: expect.stringContaining('most relevant') },
        maxChars: {
          type: 'number',
          minimum: 1000,
          maximum: 50000,
          description: expect.stringContaining('Defaults to 12000'),
        },
      },
      additionalProperties: false,
    });
  });

  it('emits numeric bounds only for number fields', () => {
    expect(toJsonSchema([
      { name: 'flag', type: 'boolean', description: 'A boolean field.' },
    ])).toEqual({
      type: 'object',
      properties: { flag: { type: 'boolean', description: 'A boolean field.' } },
      additionalProperties: false,
    });
  });

  it('resolves a tool by bare, qualified, and host-qualified action names', () => {
    for (const actionName of ['read_pdf', 'claudian.read_pdf', 'mcp__claudian__read_pdf']) {
      expect(findPluginToolByActionName(actionName)?.name).toBe('read_pdf');
    }

    expect(findPluginToolByActionName('Read')).toBeNull();
    expect(findPluginToolByActionName('pdftotext')).toBeNull();
  });

  it('renders one human-readable approval line per selection', () => {
    expect(describePluginToolAction('read_pdf', { pages: '3-5' })).toBe('Read PDF: pages 3-5');
    expect(describePluginToolAction('mcp__claudian__read_pdf', { section: 'Method' }))
      .toBe('Read PDF: section "Method"');
    expect(describePluginToolAction('read_pdf', {})).toBe('Read PDF: linked PDF, whole document');

    // Host tools are not claimed by the plugin, so approval wording is unchanged.
    expect(describePluginToolAction('Bash', { command: 'ls' })).toBeNull();
  });

  it('keeps approval rule patterns free of the human action label', () => {
    expect(pluginToolActionPattern('read_pdf', { pages: '2' })).toBe('pages 2');
    expect(pluginToolActionPattern('Bash', { command: 'ls' })).toBeNull();
  });

  it('rejects a catalog that reuses a tool name or a capability slot', () => {
    const readPdf = findPluginToolByActionName('read_pdf');
    if (!readPdf) throw new Error('read_pdf must be registered');

    expect(inspectToolSpecs([readPdf, readPdf])).toEqual([
      'claudian.read_pdf: duplicate tool name',
      'claudian.read_pdf and claudian.read_pdf both claim capability paper.read',
    ]);
    expect(() => collectTools([readPdf, readPdf])).toThrow(/Tool catalog is invalid/u);
  });

  it('rejects tools in one namespace that disagree about its description', () => {
    const readPdf = findPluginToolByActionName('read_pdf');
    if (!readPdf) throw new Error('read_pdf must be registered');

    expect(inspectToolSpecs([readPdf, {
      ...readPdf,
      capability: 'paper.other',
      name: 'other',
      namespaceDescription: 'A different namespace description.',
      qualifiedName: 'claudian.other',
    }])).toEqual([
      'claudian.other: namespace claudian has a conflicting description',
    ]);
  });

  it('accepts the shipped catalog and keeps retired names out of the registry', () => {
    expect(inspectToolSpecs(PLUGIN_TOOL_SPECS)).toEqual([]);
    // An explicit list keeps a capability from being added or dropped silently.
    expect(PLUGIN_TOOL_SPECS.map(tool => tool.qualifiedName)).toEqual([
      'claudian.browse',
      'claudian.cite',
      'claudian.read_pdf',
      'claudian.search',
      'claudian.set_paper_fields',
      'claudian.write_note',
    ]);
    for (const retiredName of RETIRED_PLUGIN_TOOL_NAMES) {
      expect(findPluginToolByActionName(retiredName)).toBeNull();
    }
  });

  it('declares read_pdf as a readable capability that needs no confirmation', () => {
    const tool = findPluginToolByActionName('read_pdf');

    expect(tool?.executionClass).toBe('read');
    expect(tool?.requiresConfirmation).toBe(false);
    expect(tool?.capability).toBe('paper.read');
    expect(tool?.instructions).toContain('read_pdf');
  });

  it('declares write_note as a write capability that requires confirmation', () => {
    const tool = findPluginToolByActionName('write_note');

    expect(tool?.executionClass).toBe('write');
    expect(tool?.requiresConfirmation).toBe(true);
    expect(tool?.capability).toBe('paper.write');
    expect(tool?.instructions).toContain('write_note');
  });

  it('declares set_paper_fields as a whitelisted write capability that requires confirmation', () => {
    const tool = findPluginToolByActionName('set_paper_fields');

    expect(tool?.executionClass).toBe('write');
    expect(tool?.requiresConfirmation).toBe(true);
    expect(tool?.capability).toBe('paper.fields');
    expect(tool?.instructions).toContain('set_paper_fields');
    // The whitelist is the schema: no other field can reach the frontmatter.
    expect(Object.keys(tool?.jsonSchema.properties ?? {})).toEqual([
      'target',
      'status',
      'domain',
      'subfield',
    ]);
  });
});
