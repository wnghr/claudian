import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import type { PaperNoteWritePort, PaperNoteWriteResult } from './PaperNoteWrite';

export const TODO_NOTE_PATH = '任务/TODO.md';
export const TODO_NOTE_SECTION = '任务清单';
export const WRITE_TODO_TOOL_NAME = 'write_todo';
export const WRITE_TODO_TOOL_VERSION = 1;
export const WRITE_TODO_TOOL_CAPABILITY = 'todo.write';
export const WRITE_TODO_TOOL_ACTION_LABEL = 'Write TODO';
export const WRITE_TODO_TOOL_DESCRIPTION =
  'Add one actionable unchecked task to the vault\'s single TODO list. The tool always writes to 任务/TODO.md and never creates categories or edits another note.';
export const WRITE_TODO_TOOL_INSTRUCTIONS =
  'Use write_todo only after the user explicitly asks to add a TODO. Never infer or auto-create tasks from a plan, discussion, or unfinished idea. It always appends one unchecked item to 任务/TODO.md; do not use Bash, Write, or Edit for TODO capture, and do not split tasks into category notes.';

const WRITE_TODO_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'content',
    type: 'string',
    description: 'A concise actionable task description without a checkbox prefix.',
  },
  {
    name: 'due',
    type: 'string',
    optional: true,
    description: 'Optional due date in YYYY-MM-DD format; omit it when no date was given.',
  },
];

export const WRITE_TODO_TOOL_JSON_SCHEMA = toJsonSchema(WRITE_TODO_TOOL_FIELDS);

export interface WriteTodoToolInput {
  readonly content: string;
  readonly due?: string;
}

export interface WriteTodoToolContext {
  readonly writer: PaperNoteWritePort;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseWriteTodoToolInput(value: unknown): WriteTodoToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('write_todo needs a content string.');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.content !== 'string') {
    throw new Error('content must be a non-empty string.');
  }

  const content = input.content
    .replace(/^\s*[-*+]\s*\[[ xX/-]\]\s*/u, '')
    .trim();
  if (!content) throw new Error('content must be a non-empty string.');

  if (input.due === undefined) return { content };
  if (typeof input.due !== 'string' || !isValidDate(input.due.trim())) {
    throw new Error('due must use YYYY-MM-DD format.');
  }
  return { content, due: input.due.trim() };
}

function formatTodoContent(input: WriteTodoToolInput): string {
  return `- [ ] ${input.content}${input.due ? ` 📅 ${input.due}` : ''}`;
}

function formatWriteTodoResult(input: WriteTodoToolInput, result: PaperNoteWriteResult): string {
  if (result.action === 'duplicate_skipped') {
    return `TODO 已存在，未重复写入：${input.content}\n${result.link}`;
  }
  return `已加入 TODO（${TODO_NOTE_PATH}）：${input.content}${input.due ? `（截止 ${input.due}）` : ''}\n${result.link}`;
}

export async function executeWriteTodoTool(
  writer: PaperNoteWritePort,
  value: unknown,
): Promise<string> {
  const input = parseWriteTodoToolInput(value);
  const result = await writer.appendToNote({
    target: TODO_NOTE_PATH,
    section: TODO_NOTE_SECTION,
    content: formatTodoContent(input),
  });
  return formatWriteTodoResult(input, result);
}

export const WRITE_TODO_TOOL_SPEC = defineTool<WriteTodoToolInput, WriteTodoToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: WRITE_TODO_TOOL_NAME,
  version: WRITE_TODO_TOOL_VERSION,
  description: WRITE_TODO_TOOL_DESCRIPTION,
  capability: WRITE_TODO_TOOL_CAPABILITY,
  actionLabel: WRITE_TODO_TOOL_ACTION_LABEL,
  executionClass: 'write',
  requiresConfirmation: true,
  fields: WRITE_TODO_TOOL_FIELDS,
  instructions: WRITE_TODO_TOOL_INSTRUCTIONS,
  parse: parseWriteTodoToolInput,
  handler: (context, input) => executeWriteTodoTool(context.writer, input),
  describeAction: input => `${TODO_NOTE_PATH} ← ${input.content}`,
});
