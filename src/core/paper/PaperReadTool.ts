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
  'Read a focused excerpt from the paper the user is working on: the attachment open in the ZotFlow reader, the source note linked to this conversation, or an explicitly named PDF. Page reads prefer an existing MinerU parse for formula and layout fidelity, then fall back to ZotFlow Reader/PDFWorker when the cache is missing or incomplete; whole-paper and query reads reuse a MinerU parse, Zotero\'s full-text cache, or a direct desktop PDF extraction, with the fidelity reported. Pass pages (including the keyword "current"), a section, or a query instead of reading the whole paper.';
export const PAPER_READ_TOOL_INSTRUCTIONS =
  'When the user refers to "this paper", "this section", or "this page", call read_pdf without a path so it follows the attachment linked to the conversation, and pass pages "current" to read the page they are looking at. Page reads use the existing MinerU cache when it covers the requested pages, then fall back to ZotFlow Reader/PDFWorker for missing or uncached pages. Read only the pages, section, or query-relevant passages needed for the request. Do not read the PDF through shell commands or ask the user to copy its path.';

const PAPER_READ_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'path',
    type: 'string',
    optional: true,
    description: 'Optional vault path to a PDF or ZotFlow source note, zotero/ATTACHKEY.pdf, or an obsidian://zotflow link. Defaults to the attachment open in the ZotFlow reader, then to the content linked to this conversation.',
  },
  {
    name: 'pages',
    type: 'string',
    optional: true,
    description: 'Optional PDF page number or range, for example 3 or 3-5, or "current" for the page the reader is on.',
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
  {
    name: 'includeImages',
    type: 'boolean',
    optional: true,
    description: 'Render requested PDF pages as images for figure inspection. Off by default.',
  },
];

export const PAPER_READ_TOOL_JSON_SCHEMA = toJsonSchema(PAPER_READ_TOOL_FIELDS);

export interface PaperReadToolInput {
  readonly path?: string;
  readonly pages?: string;
  readonly section?: string;
  readonly query?: string;
  readonly maxChars?: number;
  readonly includeImages?: boolean;
}

/** Runtime dependencies the read_pdf capability needs, supplied by each provider. */
export interface PaperReadToolContext {
  readonly reader: PaperReadPort;
  /**
   * The content linked to this conversation. Not necessarily a PDF: linking a
   * ZotFlow source note is the normal case, so the locator resolves it.
   */
  readonly getLinkedPaperPath: () => string | null;
}

const RESOLVABLE_PATH = /\.(?:pdf|md)$/iu;

function assertResolvableSourcePath(sourcePath: string): void {
  if (RESOLVABLE_PATH.test(sourcePath) || sourcePath.startsWith('zotero/')) return;
  throw new Error(
    `The requested path is neither a PDF nor a ZotFlow source note: ${sourcePath}`,
  );
}

export function parsePaperReadToolInput(value: unknown): PaperReadToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};
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
  if (input.includeImages !== undefined) {
    if (typeof input.includeImages !== 'boolean') throw new Error('includeImages must be a boolean.');
    result.includeImages = input.includeImages;
  }
  return result;
}

export async function executePaperReadTool(
  reader: PaperReadPort,
  getLinkedPaperPath: () => string | null,
  value: unknown,
): Promise<string> {
  const input = parsePaperReadToolInput(value);
  // Falling through to the host here is deliberate: with no linked content the
  // host still follows the ZotFlow reader, which only the host can inspect.
  const sourcePath = input.path?.trim() || getLinkedPaperPath() || undefined;
  if (sourcePath) assertResolvableSourcePath(sourcePath);
  // A Zotero attachment reference identifies the same document as the active
  // ZotFlow Reader. Prefer that live Reader even when the model supplied the
  // reference explicitly; otherwise a missing MinerU cache makes read_pdf
  // fail before it reaches the Reader/PDFWorker path.
  const preferActiveReader = !input.path?.trim() || sourcePath?.startsWith('zotero/') === true;
  const request: PaperReadRequest = {
    ...(sourcePath ? { sourcePath } : {}),
    ...(preferActiveReader ? { preferActiveReader: true } : {}),
    ...(input.pages ? { pages: input.pages } : {}),
    ...(input.section ? { section: input.section } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
    ...(input.includeImages !== undefined ? { includeImages: input.includeImages } : {}),
  };
  return formatPaperReadToolResult(await reader.readPaper(request));
}

function formatPaperReadToolResult(result: PaperReadResult): string {
  const lines = [
    `Source: ${result.sourcePath}`,
    `Text fidelity: ${result.fidelity}`,
    ...(result.cachePath ? [`Parsed Markdown: ${result.cachePath}`] : []),
    ...(result.pageCount !== undefined ? [`Pages with text: ${result.pageCount}`] : []),
    ...(result.currentPage
      ? [`Reader position: p.${result.currentPage.page} (from ${result.currentPage.source})`]
      : []),
    ...(result.images?.length
      ? [
        `Rendered page images: ${result.images.map(image => `p.${image.page} (${image.width}x${image.height})`).join(', ')}`,
        ...result.images.map(image => `![Rendered page ${image.page}](data:image/png;base64,${image.dataUrl.replace(/^data:image\/png;base64,/iu, '')})`),
      ]
      : []),
    `Selection: ${result.selection}`,
    `Truncated: ${result.truncated ? 'yes' : 'no'}`,
    ...result.warnings.map(warning => `Warning: ${warning}`),
  ];
  return [...lines, '', result.content].join('\n');
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
    context.getLinkedPaperPath,
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
