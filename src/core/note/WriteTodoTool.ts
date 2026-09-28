import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import type { PaperNoteWritePort, PaperNoteWriteResult } from './PaperNoteWrite';
import type { TodoPort } from './TodoService';

export const TODO_NOTE_PATH = '任务/TODO.md';
export const TODO_NOTE_SECTION = '任务清单';
export const WRITE_TODO_TOOL_NAME = 'write_todo';
export const WRITE_TODO_TOOL_VERSION = 3;
export const WRITE_TODO_TOOL_CAPABILITY = 'todo.write';
export const WRITE_TODO_TOOL_ACTION_LABEL = 'Write TODO';
export const WRITE_TODO_TOOL_DESCRIPTION =
  'Add one actionable unchecked task to the vault\'s single TODO list, with an optional free-form project label maintained in TODO and independent of 项目中心.';
export const WRITE_TODO_TOOL_INSTRUCTIONS =
  'Use write_todo only after the user explicitly asks to add a TODO. Never infer or auto-create tasks from a plan, discussion, or unfinished idea. It always appends one unchecked item to 任务/TODO.md. Project is an optional free-form label stored with that task; do not look up or write to 项目中心. Include a label only when the user names or clearly implies the project; otherwise omit it. Do not use Bash, Write, or Edit for TODO capture, and keep all tasks in the single flat list.';

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
  {
    name: 'project',
    type: 'string',
    optional: true,
    description: 'Optional free-form project label. It is a label only, not a project note path or link.',
  },
];

export const WRITE_TODO_TOOL_JSON_SCHEMA = toJsonSchema(WRITE_TODO_TOOL_FIELDS);

export interface WriteTodoToolInput {
  readonly content: string;
  readonly due?: string;
  readonly project?: string;
}

export interface WriteTodoToolContext {
  readonly writer: PaperNoteWritePort;
  readonly todos?: TodoPort;
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

  let due: string | undefined;
  if (input.due !== undefined) {
    if (typeof input.due !== 'string' || !isValidDate(input.due.trim())) {
      throw new Error('due must use YYYY-MM-DD format.');
    }
    due = input.due.trim();
  }

  let project: string | undefined;
  if (input.project !== undefined) {
    if (typeof input.project !== 'string') throw new Error('project must be a string label.');
    project = input.project.trim();
    if (!project || project.length > 80 || /[<>\r\n]|--/u.test(project)) {
      throw new Error('project must be a non-empty label up to 80 characters without angle brackets, newlines, or double hyphens.');
    }
  }

  return {
    content,
    ...(due ? { due } : {}),
    ...(project ? { project } : {}),
  };
}

function formatTodoContent(input: WriteTodoToolInput): string {
  const task = formatTodoTask(input);
  return input.project ? `<!-- todo-project: ${input.project} -->\n${task}` : task;
}

function formatTodoTask(input: WriteTodoToolInput): string {
  return `- [ ] ${input.content}${input.due ? ` 📅 ${input.due}` : ''}`;
}

function formatWriteTodoResult(input: WriteTodoToolInput, result: PaperNoteWriteResult): string {
  if (result.action === 'duplicate_skipped') {
    return `TODO 已存在，未重复写入：${input.content}${input.project ? `（项目：${input.project}）` : ''}\n${result.link}`;
  }
  return `已加入 TODO（${TODO_NOTE_PATH}）：${input.content}${input.project ? `（项目：${input.project}）` : ''}${input.due ? `（截止 ${input.due}）` : ''}\n${result.link}`;
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
    ...(input.project ? { duplicateProbe: formatTodoTask(input) } : {}),
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
  handler: async (context, input) => {
    if (!context.todos) return executeWriteTodoTool(context.writer, input);
    const snapshot = await context.todos.readTodos({});
    if (snapshot.tasks.some(task => task.content === input.content && (task.project ?? '') === (input.project ?? ''))) {
      return `TODO 已存在，未重复写入：${input.content}\n[[任务/TODO]]`;
    }
    const result = await context.todos.changeTodos({ revision: snapshot.revision, summary: `添加任务：${input.content}`, operations: [{ op: 'add', task: input }] });
    return `已加入 TODO（${TODO_NOTE_PATH}）：${input.content}\n${JSON.stringify(result)}`;
  },
  describeAction: input => `${TODO_NOTE_PATH} ← ${input.content}${input.project ? ` · ${input.project}` : ''}`,
});
