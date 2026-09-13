import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import {
  PAPER_SEARCH_DEFAULT_LIMIT,
  PAPER_SEARCH_KINDS,
  PAPER_SEARCH_MAX_LIMIT,
  PAPER_SEARCH_MODES,
  type PaperSearchHit,
  type PaperSearchKind,
  type PaperSearchMode,
  type PaperSearchPort,
  type PaperSearchRequest,
  type PaperSearchResult,
} from './PaperSearch';

export const SEARCH_TOOL_NAME = 'search';
export const SEARCH_TOOL_VERSION = 1;
export const SEARCH_TOOL_CAPABILITY = 'paper.search';
export const SEARCH_TOOL_ACTION_LABEL = 'Search papers';
export const SEARCH_TOOL_DESCRIPTION =
  "Search the vault's papers, cards, and research notes for passages that answer a question. Combines keyword ranking with embedding-based semantic ranking, and returns every hit with a vault path, heading, and page locator so the answer can be cited. Use it instead of grepping the vault: it finds passages with no literal keyword match and reports the page a passage came from.";
export const SEARCH_TOOL_INSTRUCTIONS =
  'Use the Claudian search tool to locate relevant passages in the paper library before answering a question about the literature. Cite each hit by its path, heading, and page or line locator. Do not grep vault folders for paper content.';

const SEARCH_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'query',
    type: 'string',
    description: 'What to look for, in natural language or as keywords.',
  },
  {
    name: 'mode',
    type: 'string',
    optional: true,
    description:
      'Retrieval mode: hybrid (default), keyword, or semantic. '
      + 'semantic fails when no embedding endpoint is configured.',
  },
  {
    name: 'limit',
    type: 'number',
    optional: true,
    minimum: 1,
    maximum: PAPER_SEARCH_MAX_LIMIT,
    description: `Maximum passages returned. Defaults to ${PAPER_SEARCH_DEFAULT_LIMIT}.`,
  },
  {
    name: 'scope',
    type: 'string',
    optional: true,
    description:
      'Optional restriction to a vault-relative folder or path segment, '
      + 'for example 论文/MD or a citekey.',
  },
  {
    name: 'kind',
    type: 'string',
    optional: true,
    description: 'Optional restriction to md (document bodies) or meta (card frontmatter).',
  },
];

export const SEARCH_TOOL_JSON_SCHEMA = toJsonSchema(SEARCH_TOOL_FIELDS);

export interface SearchToolInput {
  readonly query: string;
  readonly mode?: PaperSearchMode;
  readonly limit?: number;
  readonly scope?: string;
  readonly kind?: PaperSearchKind;
}

/** Runtime dependency the search capability needs, supplied by each provider. */
export interface SearchToolContext {
  readonly search: PaperSearchPort;
}

function isSearchMode(value: string): value is PaperSearchMode {
  return (PAPER_SEARCH_MODES as readonly string[]).includes(value);
}

function isSearchKind(value: string): value is PaperSearchKind {
  return (PAPER_SEARCH_KINDS as readonly string[]).includes(value);
}

export function parseSearchToolInput(value: unknown): SearchToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('search needs a query.');
  }
  const input = value as Record<string, unknown>;

  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw new Error('query must be a non-empty string.');
  }
  const result: {
    query: string;
    mode?: PaperSearchMode;
    limit?: number;
    scope?: string;
    kind?: PaperSearchKind;
  } = { query: input.query.trim() };

  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !isSearchMode(input.mode.trim())) {
      throw new Error(`mode must be one of ${PAPER_SEARCH_MODES.join(', ')}.`);
    }
    result.mode = input.mode.trim() as PaperSearchMode;
  }
  if (input.kind !== undefined) {
    if (typeof input.kind !== 'string' || !isSearchKind(input.kind.trim())) {
      throw new Error(`kind must be one of ${PAPER_SEARCH_KINDS.join(', ')}.`);
    }
    result.kind = input.kind.trim() as PaperSearchKind;
  }
  if (input.scope !== undefined) {
    if (typeof input.scope !== 'string') throw new Error('scope must be a string.');
    if (input.scope.trim()) result.scope = input.scope.trim();
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
      throw new Error('limit must be a number.');
    }
    const limit = Math.floor(input.limit);
    if (limit < 1 || limit > PAPER_SEARCH_MAX_LIMIT) {
      throw new Error(`limit must be between 1 and ${PAPER_SEARCH_MAX_LIMIT}.`);
    }
    result.limit = limit;
  }
  return result;
}

const MODE_LABELS: Readonly<Record<PaperSearchMode, string>> = {
  hybrid: 'keywords + vectors',
  keyword: 'keywords only',
  semantic: 'vectors only',
};

function formatHit(hit: PaperSearchHit, position: number): readonly string[] {
  const location = [hit.path, hit.heading, hit.locator].filter(Boolean).join('  §  ');
  return [
    `${position}. [${hit.score.toFixed(4)}] ${location}`,
    ...(hit.snippet ? [`   ${hit.snippet}`] : []),
  ];
}

export function formatPaperSearchResult(result: PaperSearchResult): string {
  const header = `Search: ${result.query}   (${MODE_LABELS[result.mode]}, ${result.hits.length} hits)`;
  // The embedded count is only meaningful when vectors took part in the ranking.
  const index = result.mode === 'keyword'
    ? `Index: ${result.index.files} files, ${result.index.chunks} chunks`
    : `Index: ${result.index.files} files, ${result.index.chunks} chunks, `
      + `${result.index.embedded} embedded`;

  if (result.hits.length === 0) {
    return [
      header,
      index,
      ...(result.degraded ? [`Degraded: ${result.degraded}`] : []),
      '',
      'No passages matched. Try different terms, drop scope, or check that the paper '
      + 'has been parsed into 论文/MD.',
    ].join('\n');
  }

  return [
    header,
    index,
    ...(result.degraded ? [`Degraded: ${result.degraded}`] : []),
    '',
    ...result.hits.flatMap((hit, position) => formatHit(hit, position + 1)),
  ].join('\n');
}

export async function executeSearchTool(
  search: PaperSearchPort,
  value: unknown,
): Promise<string> {
  const input = parseSearchToolInput(value);
  const request: PaperSearchRequest = input;
  return formatPaperSearchResult(await search.searchPapers(request));
}

/** The single definition point for search; provider adapters derive from it. */
export const SEARCH_TOOL_SPEC = defineTool<SearchToolInput, SearchToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: SEARCH_TOOL_NAME,
  version: SEARCH_TOOL_VERSION,
  description: SEARCH_TOOL_DESCRIPTION,
  capability: SEARCH_TOOL_CAPABILITY,
  actionLabel: SEARCH_TOOL_ACTION_LABEL,
  executionClass: 'read',
  requiresConfirmation: false,
  fields: SEARCH_TOOL_FIELDS,
  instructions: SEARCH_TOOL_INSTRUCTIONS,
  parse: parseSearchToolInput,
  handler: (context, input) => executeSearchTool(context.search, input),
  describeAction: input => describeSearchSelection(input),
});

function describeSearchSelection(input: SearchToolInput): string {
  const parts = [`query "${input.query}"`];
  if (input.mode) parts.push(input.mode);
  if (input.scope) parts.push(`in ${input.scope}`);
  return parts.join(', ');
}
