import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import type { PaperAuthor, PaperCitation, PaperCitationPort } from './PaperLibrary';
import { formatPaperReference } from './referenceFormat';

export const CITE_TOOL_NAME = 'cite';
export const CITE_TOOL_VERSION = 1;
export const CITE_TOOL_CAPABILITY = 'paper.cite';
export const CITE_TOOL_ACTION_LABEL = 'Cite paper';
export const CITE_TOOL_DESCRIPTION =
  "Return bibliographic fields and a paste-ready reference line for one paper, looked up by citekey in this vault's bibliography index. Use it whenever prose must cite a paper, instead of copying metadata out of a card or recalling it from memory.";
export const CITE_TOOL_INSTRUCTIONS =
  'Use the Claudian cite tool for bibliographic metadata. Never restate a reference from memory.';

const CITE_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'citekey',
    type: 'string',
    description:
      'Citekey from the paper library, for example asilehanlightdriven2025. A DOI also resolves.',
  },
];

export const CITE_TOOL_JSON_SCHEMA = toJsonSchema(CITE_TOOL_FIELDS);

export interface CiteToolInput {
  readonly citekey: string;
}

/** Runtime dependency the cite capability needs, supplied by each provider. */
export interface CiteToolContext {
  readonly library: PaperCitationPort;
}

export function parseCiteToolInput(value: unknown): CiteToolInput {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const citekey = typeof input.citekey === 'string' ? input.citekey.trim() : '';
  if (!citekey) throw new Error('citekey is required, for example asilehanlightdriven2025.');
  return { citekey };
}

function formatAuthor(author: PaperAuthor): string {
  if (!author.family) return author.given;
  return author.given ? `${author.family}, ${author.given}` : author.family;
}

export function formatCitationOutput(citation: PaperCitation): string {
  const source = [
    citation.venue,
    citation.volume
      ? `${citation.volume}${citation.issue ? `(${citation.issue})` : ''}`
      : citation.issue
        ? `(${citation.issue})`
        : null,
    citation.pages,
  ].filter(Boolean).join(', ');
  return [
    `Citekey: ${citation.citekey}`,
    `Reference: ${formatPaperReference(citation)}`,
    `Authors: ${citation.authors.length > 0 ? citation.authors.map(formatAuthor).join('; ') : 'unknown'}`,
    `Source: ${source || 'unknown'}`,
    `DOI: ${citation.doi ?? 'none'}`,
    `URL: ${citation.url ?? 'none'}`,
  ].join('\n');
}

export async function executeCiteTool(
  citations: PaperCitationPort,
  value: unknown,
): Promise<string> {
  const input = parseCiteToolInput(value);
  return formatCitationOutput(await citations.citePaper(input.citekey));
}

/** The single definition point for cite; provider adapters derive from it. */
export const CITE_TOOL_SPEC = defineTool<CiteToolInput, CiteToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: CITE_TOOL_NAME,
  version: CITE_TOOL_VERSION,
  description: CITE_TOOL_DESCRIPTION,
  capability: CITE_TOOL_CAPABILITY,
  actionLabel: CITE_TOOL_ACTION_LABEL,
  executionClass: 'read',
  requiresConfirmation: false,
  fields: CITE_TOOL_FIELDS,
  instructions: CITE_TOOL_INSTRUCTIONS,
  parse: parseCiteToolInput,
  handler: (context, input) => executeCiteTool(context.library, input),
  describeAction: input => input.citekey,
});
