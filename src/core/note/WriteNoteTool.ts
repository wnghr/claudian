import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import {
  DEFAULT_APPEND_SECTION,
  type PaperNoteWritePort,
  type PaperNoteWriteRequest,
  type PaperNoteWriteResult,
} from './PaperNoteWrite';

export const WRITE_NOTE_TOOL_NAME = 'write_note';
export const WRITE_NOTE_TOOL_VERSION = 1;
export const WRITE_NOTE_TOOL_CAPABILITY = 'paper.write';
export const WRITE_NOTE_TOOL_ACTION_LABEL = 'Write note';
export const WRITE_NOTE_TOOL_DESCRIPTION =
  "Append a dated block to a note or paper card in this vault, under a section heading (default 讨论与理解). Use it to record an interpretation, a question, or a reading conclusion into the vault so it survives the conversation. Refuses to write the same content twice unless told otherwise, and preserves the note's frontmatter.";
export const WRITE_NOTE_TOOL_INSTRUCTIONS =
  'Use the Claudian write_note tool to save conclusions, interpretations, or follow-up questions into vault notes and paper cards. Never edit paper cards or parse products by hand with file tools; write_note appends safely under the right section.';

const WRITE_NOTE_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'target',
    type: 'string',
    description:
      'Which note to write into: a vault path, a note name, or a paper citekey. Wiki-link brackets are tolerated.',
  },
  {
    name: 'content',
    type: 'string',
    description: 'The text to append, written as the final version — markdown allowed.',
  },
  {
    name: 'section',
    type: 'string',
    optional: true,
    description:
      `Heading to append under. Defaults to ${DEFAULT_APPEND_SECTION}; ` +
      'shortened section names (讨论, 想法, next) resolve to their canonical section.',
  },
  {
    name: 'allowDuplicate',
    type: 'boolean',
    optional: true,
    description:
      'Set true only when the same content is legitimately needed again; ' +
      'otherwise an identical block is skipped.',
  },
];

export const WRITE_NOTE_TOOL_JSON_SCHEMA = toJsonSchema(WRITE_NOTE_TOOL_FIELDS);

export interface WriteNoteToolInput {
  readonly target: string;
  readonly content: string;
  readonly section?: string;
  readonly allowDuplicate?: boolean;
}

/** Runtime dependency the write capability needs, supplied by each provider. */
export interface WriteNoteToolContext {
  readonly writer: PaperNoteWritePort;
}

export function parseWriteNoteToolInput(value: unknown): WriteNoteToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('write_note needs a target and content.');
  }
  const input = value as Record<string, unknown>;

  if (typeof input.target !== 'string' || !input.target.trim()) {
    throw new Error('target must be a non-empty note path, name, or citekey.');
  }
  if (typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('content must be a non-empty string.');
  }
  const result: {
    target: string;
    content: string;
    section?: string;
    allowDuplicate?: boolean;
  } = { target: input.target.trim(), content: input.content };

  if (input.section !== undefined) {
    if (typeof input.section !== 'string' || !input.section.trim()) {
      throw new Error('section must be a non-empty heading name.');
    }
    result.section = input.section.trim();
  }
  if (input.allowDuplicate !== undefined) {
    if (typeof input.allowDuplicate !== 'boolean') {
      throw new Error('allowDuplicate must be a boolean.');
    }
    result.allowDuplicate = input.allowDuplicate;
  }
  return result;
}

export function formatPaperNoteWriteResult(result: PaperNoteWriteResult): string {
  const lines = [
    result.action === 'appended' ? `已写入 ${result.path}   ${result.location}` : result.location,
    `链接：${result.link}`,
  ];
  if (result.action === 'appended' && !result.backupPath) {
    lines.push('注意：本次写入没有备份文件。');
  }
  if (result.alternates && result.alternates.length > 0) {
    lines.push('同名笔记不止一个，已写入第一个；其他匹配：');
    for (const alternate of result.alternates) lines.push(`  · ${alternate}`);
  }
  return lines.join('\n');
}

export async function executeWriteNoteTool(
  writer: PaperNoteWritePort,
  value: unknown,
): Promise<string> {
  const input = parseWriteNoteToolInput(value);
  const request: PaperNoteWriteRequest = input;
  return formatPaperNoteWriteResult(await writer.appendToNote(request));
}

/** The single definition point for write_note; provider adapters derive from it. */
export const WRITE_NOTE_TOOL_SPEC = defineTool<WriteNoteToolInput, WriteNoteToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: WRITE_NOTE_TOOL_NAME,
  version: WRITE_NOTE_TOOL_VERSION,
  description: WRITE_NOTE_TOOL_DESCRIPTION,
  capability: WRITE_NOTE_TOOL_CAPABILITY,
  actionLabel: WRITE_NOTE_TOOL_ACTION_LABEL,
  executionClass: 'write',
  requiresConfirmation: true,
  fields: WRITE_NOTE_TOOL_FIELDS,
  instructions: WRITE_NOTE_TOOL_INSTRUCTIONS,
  parse: parseWriteNoteToolInput,
  handler: (context, input) => executeWriteNoteTool(context.writer, input),
  describeAction: input => `${input.target} ← ${input.section ?? DEFAULT_APPEND_SECTION}`,
});
