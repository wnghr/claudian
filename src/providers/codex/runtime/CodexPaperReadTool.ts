import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { CodexDynamicToolRegistration } from './CodexDynamicToolRegistry';

export const CODEX_PAPER_READ_TOOL_NAMESPACE = 'claudian';
export const CODEX_PAPER_READ_TOOL_NAME = 'read_pdf';
export const CODEX_PAPER_READ_TOOL_VERSION = 1;

interface ToolArguments {
  path?: string;
  pages?: string;
  section?: string;
  query?: string;
  maxChars?: number;
}

function parseArguments(value: unknown): ToolArguments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: ToolArguments = {};
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

export function createCodexPaperReadTool(
  host: ProviderHost,
  getLinkedPdfPath: () => string | null,
): CodexDynamicToolRegistration {
  return {
    includeInThreadStart: true,
    namespace: {
      name: CODEX_PAPER_READ_TOOL_NAMESPACE,
      description: 'Read the PDF currently linked in Claudian through its validated Markdown cache.',
    },
    tool: {
      type: 'function',
      name: CODEX_PAPER_READ_TOOL_NAME,
      description: 'Read a focused excerpt from the currently linked vault PDF. The tool validates the PDF hash, reuses or automatically creates the MinerU Markdown cache, and returns source-located content. Prefer pages, section, or query instead of reading the entire paper.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional vault-relative PDF path. Defaults to the PDF linked to this Claudian conversation.',
          },
          pages: {
            type: 'string',
            description: 'Optional PDF page number or range, for example 3 or 3-5. Requires a paged cache.',
          },
          section: {
            type: 'string',
            description: 'Optional Markdown section heading to read.',
          },
          query: {
            type: 'string',
            description: 'Optional terms used to select the most relevant cached passages.',
          },
          maxChars: {
            type: 'number',
            minimum: 1000,
            maximum: 50000,
            description: 'Maximum returned characters. Defaults to 12000.',
          },
        },
        additionalProperties: false,
      },
    },
    handler: async params => {
      try {
        const args = parseArguments(params.arguments);
        const sourcePath = args.path?.trim() || getLinkedPdfPath();
        if (!sourcePath) {
          throw new Error('No PDF is linked to this Claudian conversation. Open or link a PDF first.');
        }
        if (!sourcePath.toLocaleLowerCase().endsWith('.pdf')) {
          throw new Error(`The requested path is not a PDF: ${sourcePath}`);
        }
        const result = await host.readPaper({
          sourcePath,
          ...(args.pages ? { pages: args.pages } : {}),
          ...(args.section ? { section: args.section } : {}),
          ...(args.query ? { query: args.query } : {}),
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
        });
        return {
          success: true,
          contentItems: [{
            type: 'inputText',
            text: [
              `Source PDF: ${result.sourcePath}`,
              `Cache: ${result.cachePath}`,
              `Selection: ${result.selection}`,
              `Truncated: ${result.truncated ? 'yes' : 'no'}`,
              '',
              result.content,
            ].join('\n'),
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
