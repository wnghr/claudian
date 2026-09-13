import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import type { PaperReadPort, PaperReadRequest, PaperReadResult } from './PaperRead';

export const PAPER_READ_TOOL_NAME = 'read_pdf';
export const PAPER_READ_TOOL_VERSION = 1;
export const PAPER_READ_TOOL_CAPABILITY = 'paper.read';
export const PAPER_READ_TOOL_ACTION_LABEL = 'Read PDF';
export const PAPER_READ_TOOL_DESCRIPTION =
  'Read a focused excerpt from the currently linked vault PDF. The tool validates the PDF hash, reuses or automatically creates the MinerU Markdown cache, and returns source-located content. Prefer pages, section, or query instead of reading the entire paper.';
export const PAPER_READ_TOOL_INSTRUCTIONS =
  'When Linked content is a PDF, use the Claudian read_pdf tool to read only the pages, section, or query-relevant passages needed for the request. Do not read the PDF through shell commands or ask the user to copy its path.';

const PAPER_READ_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'path',
    type: 'string',
    optional: true,
    description: 'Optional vault-relative PDF path. Defaults to the PDF linked to this Claudian conversation.',
  },
  {
    name: 'pages',
    type: 'string',
    optional: true,
    description: 'Optional PDF page number or range, for example 3 or 3-5. Requires a paged cache.',
  },
  {
    name: 'section',
    type: 'string',
    optional: true,
    description: 'Optional Markdown section heading to read.',
  },
  {
    name: 'query',
    type: 'string',
    optional: true,
    description: 'Optional terms used to select the most relevant cached passages.',
  },
  {
    name: 'maxChars',
    type: 'number',
    optional: true,
    minimum: 1000,
    maximum: 50000,
    description: 'Maximum returned characters. Defaults to 12000.',
  },
];

export const PAPER_READ_TOOL_JSON_SCHEMA = toJsonSchema(PAPER_READ_TOOL_FIELDS);

export interface PaperReadToolInput {
  readonly path?: string;
  readonly pages?: string;
  readonly section?: string;
  readonly query?: string;
  readonly maxChars?: number;
}

/** Runtime dependencies the read_pdf capability needs, supplied by each provider. */
export interface PaperReadToolContext {
  readonly reader: PaperReadPort;
  readonly getLinkedPdfPath: () => string | null;
}

export function parsePaperReadToolInput(value: unknown): PaperReadToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ['path', 'pages', 'section', 'query'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} must be a string.`);
      result[key] = input[key];
    }
  }
  if (input.maxChars !== undefined) {
    if (typeof input.maxChars !== 'number' || !Number.isFinite(input.maxChars)) {
      throw new Error('maxChars must be a number.');
    }
    result.maxChars = input.maxChars;
  }
  return result;
}

export async function executePaperReadTool(
  reader: PaperReadPort,
  getLinkedPdfPath: () => string | null,
  value: unknown,
): Promise<string> {
  const input = parsePaperReadToolInput(value);
  const sourcePath = input.path?.trim() || getLinkedPdfPath();
  if (!sourcePath) {
    throw new Error('No PDF is linked to this Claudian conversation. Open or link a PDF first.');
  }
  if (!sourcePath.toLocaleLowerCase().endsWith('.pdf')) {
    throw new Error(`The requested path is not a PDF: ${sourcePath}`);
  }
  const request: PaperReadRequest = {
    sourcePath,
    ...(input.pages ? { pages: input.pages } : {}),
    ...(input.section ? { section: input.section } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
  };
  return formatPaperReadToolResult(await reader.readPaper(request));
}

function formatPaperReadToolResult(result: PaperReadResult): string {
  return [
    `Source PDF: ${result.sourcePath}`,
    `Cache: ${result.cachePath}`,
    `Selection: ${result.selection}`,
    `Truncated: ${result.truncated ? 'yes' : 'no'}`,
    '',
    result.content,
  ].join('\n');
}

/** The single definition point for read_pdf; provider adapters derive from it. */
export const PAPER_READ_TOOL_SPEC = defineTool<PaperReadToolInput, PaperReadToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: PAPER_READ_TOOL_NAME,
  version: PAPER_READ_TOOL_VERSION,
  description: PAPER_READ_TOOL_DESCRIPTION,
  capability: PAPER_READ_TOOL_CAPABILITY,
  actionLabel: PAPER_READ_TOOL_ACTION_LABEL,
  executionClass: 'read',
  requiresConfirmation: false,
  fields: PAPER_READ_TOOL_FIELDS,
  instructions: PAPER_READ_TOOL_INSTRUCTIONS,
  parse: parsePaperReadToolInput,
  handler: (context, input) => executePaperReadTool(
    context.reader,
    context.getLinkedPdfPath,
    input,
  ),
  describeAction: input => describePaperReadSelection(input),
});

function describePaperReadSelection(input: PaperReadToolInput): string {
  const parts: string[] = [];
  if (input.path) parts.push(input.path);
  if (input.pages) parts.push(`pages ${input.pages}`);
  if (input.section) parts.push(`section "${input.section}"`);
  if (input.query) parts.push(`query "${input.query}"`);
  return parts.length > 0 ? parts.join(', ') : 'linked PDF, whole document';
}
