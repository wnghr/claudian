import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import type { PaperLibraryBrowsePort, PaperLibraryEntry, PaperLibraryQuery } from './PaperLibrary';

export const BROWSE_TOOL_NAME = 'browse';
export const BROWSE_TOOL_VERSION = 1;
export const BROWSE_TOOL_CAPABILITY = 'paper.browse';
export const BROWSE_TOOL_ACTION_LABEL = 'Browse paper library';
export const BROWSE_TOOL_DESCRIPTION =
  "List the papers in this vault's paper library with title, year, domain, reading status, and MinerU cache state. Use it to find the citekey or PDF path before reading a paper, to check which papers are already parsed, or to answer questions about the library itself. Filter with query (matches title, citekey, domain, and subfield) and status.";
export const BROWSE_TOOL_INSTRUCTIONS =
  'Use the Claudian browse tool to enumerate the paper library. Do not list vault folders or grep for citekeys to answer library questions.';

export const BROWSE_TOOL_DEFAULT_LIMIT = 50;
export const BROWSE_TOOL_MAX_LIMIT = 200;

const BROWSE_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'query',
    type: 'string',
    optional: true,
    description: 'Optional case-insensitive filter over title, citekey, domain, and subfield.',
  },
  {
    name: 'status',
    type: 'string',
    optional: true,
    description: 'Optional reading-status filter, for example unread, reading, read, or cited.',
  },
  {
    name: 'limit',
    type: 'number',
    optional: true,
    minimum: 1,
    maximum: BROWSE_TOOL_MAX_LIMIT,
    description: `Maximum entries returned. Defaults to ${BROWSE_TOOL_DEFAULT_LIMIT}.`,
  },
];

export const BROWSE_TOOL_JSON_SCHEMA = toJsonSchema(BROWSE_TOOL_FIELDS);

export interface BrowseToolInput {
  readonly query?: string;
  readonly status?: string;
  readonly limit?: number;
}

/** Runtime dependency the browse capability needs, supplied by each provider. */
export interface BrowseToolContext {
  readonly library: PaperLibraryBrowsePort;
}

export function parseBrowseToolInput(value: unknown): BrowseToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ['query', 'status'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} must be a string.`);
      if (input[key].trim()) result[key] = input[key].trim();
    }
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
      throw new Error('limit must be a number.');
    }
    const limit = Math.floor(input.limit);
    if (limit < 1 || limit > BROWSE_TOOL_MAX_LIMIT) {
      throw new Error(`limit must be between 1 and ${BROWSE_TOOL_MAX_LIMIT}.`);
    }
    result.limit = limit;
  }
  return result;
}

function toQuery(input: BrowseToolInput): PaperLibraryQuery {
  return {
    ...(input.query ? { query: input.query } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function formatEntry(entry: PaperLibraryEntry): string {
  const classification = [entry.domain, entry.subfield].filter(Boolean).join(' / ');
  const cache = entry.cache === 'ready' && entry.pages !== null
    ? `ready, ${entry.pages} pages`
    : entry.cache;
  return [
    entry.citekey,
    entry.year ?? 'n.d.',
    classification || 'unclassified',
    entry.status ?? 'status unknown',
    `cache ${cache}`,
    entry.title,
  ].join(' | ');
}

export async function executeBrowseTool(
  library: PaperLibraryBrowsePort,
  value: unknown,
): Promise<string> {
  const input = parseBrowseToolInput(value);
  const entries = await library.listPapers(toQuery(input));
  if (entries.length === 0) {
    const filters = [
      input.query ? `query "${input.query}"` : null,
      input.status ? `status "${input.status}"` : null,
    ].filter(Boolean).join(' and ');
    return filters
      ? `No papers match ${filters}.`
      : 'The paper library is empty. Import a paper into 论文/卡片 first.';
  }

  const limit = input.limit ?? BROWSE_TOOL_DEFAULT_LIMIT;
  const shown = entries.slice(0, limit);
  const header = entries.length > shown.length
    ? `Papers: ${entries.length} matched, showing ${shown.length}`
    : `Papers: ${entries.length}`;
  return [
    header,
    ...shown.map(formatEntry),
  ].join('\n');
}

/** The single definition point for browse; provider adapters derive from it. */
export const BROWSE_TOOL_SPEC = defineTool<BrowseToolInput, BrowseToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: BROWSE_TOOL_NAME,
  version: BROWSE_TOOL_VERSION,
  description: BROWSE_TOOL_DESCRIPTION,
  capability: BROWSE_TOOL_CAPABILITY,
  actionLabel: BROWSE_TOOL_ACTION_LABEL,
  executionClass: 'read',
  requiresConfirmation: false,
  fields: BROWSE_TOOL_FIELDS,
  instructions: BROWSE_TOOL_INSTRUCTIONS,
  parse: parseBrowseToolInput,
  handler: (context, input) => executeBrowseTool(context.library, input),
  describeAction: input => describeBrowseSelection(input),
});

function describeBrowseSelection(input: BrowseToolInput): string {
  const parts = [
    input.query ? `query "${input.query}"` : null,
    input.status ? `status "${input.status}"` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'all papers';
}
