import { PLUGIN_TOOL_NAMESPACE, PLUGIN_TOOL_NAMESPACE_DESCRIPTION } from '../tools/pluginToolNamespace';
import { defineTool } from '../tools/ToolSpec';
import type { TodoDraft, TodoOperation } from './TodoDocument';
import type { TodoChange, TodoPort, TodoQuery, TodoUndo } from './TodoService';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown TODO field.');
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}
function draft(value: unknown, partial = false): Partial<TodoDraft> {
  const input = object(value);
  keys(input, ['content', 'project', 'due', 'status']);
  if (!Object.keys(input).length) throw new Error('No task changes specified.');
  if (!partial || input.content !== undefined) string(input.content, 'content');
  for (const key of ['project', 'due']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} must be a string.`);
  if (input.status !== undefined && !['pending', 'done', 'paused'].includes(String(input.status))) throw new Error('Invalid status.');
  return input;
}
export function parseTodoChange(value: unknown): TodoChange {
  const input = object(value);
  keys(input, ['revision', 'summary', 'operations']);
  const revision = string(input.revision, 'revision');
  const summary = string(input.summary, 'summary');
  // Confirmation rendering receives parsed input; transport input uses JSON text.
  const raw: unknown = typeof input.operations === 'string'
    ? JSON.parse(string(input.operations, 'operations'))
    : input.operations;
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error('Provide 1–100 operations.');
  const operations: TodoOperation[] = raw.map(value => {
    const op = object(value);
    switch (op.op) {
      case 'add':
        keys(op, ['op', 'task']);
        return { op: 'add', task: draft(op.task) as TodoDraft };
      case 'update':
        keys(op, ['op', 'id', 'changes']);
        return { op: 'update', id: string(op.id, 'id'), changes: draft(op.changes, true) };
      case 'split':
        keys(op, ['op', 'id', 'tasks']);
        if (!Array.isArray(op.tasks) || op.tasks.length < 2 || op.tasks.length > 50) throw new Error('Split needs 2–50 steps.');
        return { op: 'split', id: string(op.id, 'id'), tasks: op.tasks.map(task => draft(task) as TodoDraft) };
      case 'merge':
        keys(op, ['op', 'ids', 'task']);
        if (!Array.isArray(op.ids)) throw new Error('ids must be an array.');
        return { op: 'merge', ids: op.ids.map(id => string(id, 'id')), task: draft(op.task) as TodoDraft };
      case 'move':
        keys(op, ['op', 'id', 'targetId', 'position']);
        if (op.position !== 'before' && op.position !== 'after') throw new Error('position must be before or after.');
        return { op: 'move', id: string(op.id, 'id'), targetId: string(op.targetId, 'targetId'), position: op.position };
      default: throw new Error('Unknown TODO operation.');
    }
  });
  return { revision, summary, operations };
}
function parseQuery(value: unknown): TodoQuery {
  const input = object(value);
  keys(input, ['query', 'project', 'status']);
  for (const key of ['query', 'project', 'status']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} must be a string.`);
  if (input.status && !['pending', 'done', 'paused', 'all'].includes(String(input.status))) throw new Error('Invalid status.');
  return input;
}
const namespace = { namespace: PLUGIN_TOOL_NAMESPACE, namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION };
interface Context { todos: TodoPort }

export const READ_TODOS_TOOL_SPEC = defineTool<TodoQuery, Context>({
  ...namespace, name: 'read_todos', version: 1, capability: 'todo.read', actionLabel: 'Read TODO',
  description: 'Read and filter the single TODO list, returning task IDs, current revision, source details, status and undo availability. Use before planning or changing learning tasks.',
  executionClass: 'read', requiresConfirmation: false,
  fields: [
    { name: 'query', type: 'string', optional: true, description: 'Words to match in task content and details.' },
    { name: 'project', type: 'string', optional: true, description: 'Exact project label; omit for all projects.' },
    { name: 'status', type: 'string', optional: true, description: 'pending, done, paused or all (default).' },
  ],
  instructions: 'Use read_todos to resume learning or inspect tasks. TODO is the sole progress record; use existing notes for understanding. Do not maintain a separate learning homepage or breakpoint log. Task IDs and revisions are internal: do not ask the user to supply them.',
  parse: parseQuery, handler: async (context, query) => JSON.stringify(await context.todos.readTodos(query)),
  describeAction: query => `任务/TODO.md${query.project ? ` · ${query.project}` : ''}`,
});
export const CHANGE_TODOS_TOOL_SPEC = defineTool<TodoChange, Context>({
  ...namespace, name: 'change_todos', version: 1, capability: 'todo.change', actionLabel: 'Adjust TODO',
  description: 'Apply an explicitly requested TODO adjustment atomically: add, update, split, merge or move tasks. Preserve completed work and sources. Read task IDs and revision first.',
  executionClass: 'write', requiresConfirmation: true,
  fields: [
    { name: 'revision', type: 'string', description: 'Exact revision from the latest read_todos result; stale revisions are rejected.' },
    { name: 'summary', type: 'string', description: 'Brief user-readable description of the complete adjustment.' },
    { name: 'operations', type: 'string', description: 'JSON array: {op:"add",task:{content,project?,due?,status?}}; {op:"update",id,changes:{content?,project?,due?,status?}}; {op:"split",id,tasks:[{content,project?,due?,status?},...]}; {op:"merge",ids:[...],task:{content,project?,due?,status?}}; {op:"move",id,targetId,position:"before"|"after"}. status is pending|done|paused; due is YYYY-MM-DD or empty to remove. IDs come from read_todos. Split retains original ID on first child; merge retains the earliest selected ID. New child IDs are returned after the batch.' },
  ],
  instructions: 'Use change_todos only for explicit user requests to add, adjust, complete or resume tasks, including an authorized learning plan. Resolve intent with read_todos; ask only when the target or intended change is ambiguous. Ordinary questions do not authorize changes. Bundle related edits in one call. Keep materials and completion criteria in each useful step, preserve completed records, and flag prerequisite impacts. Never mark learning complete merely because you explained it. Do not edit TODO through shell/file tools. Report the actual change and offer undo when available.',
  parse: parseTodoChange, handler: async (context, change) => JSON.stringify(await context.todos.changeTodos(change)),
  describeAction: change => `${change.summary} · ${change.operations.length} 项操作 · 任务/TODO.md`,
});
export const UNDO_TODOS_TOOL_SPEC = defineTool<TodoUndo, Context>({
  ...namespace, name: 'undo_todos', version: 1, capability: 'todo.undo', actionLabel: 'Undo TODO',
  description: 'Undo the latest complete chat adjustment to TODO, including a batch split or reorder. Refuses to overwrite subsequent manual or unrelated edits.',
  executionClass: 'write', requiresConfirmation: true,
  fields: [{ name: 'revision', type: 'string', description: 'Current revision from read_todos.' }],
  instructions: 'Use undo_todos when the user asks to undo the latest TODO adjustment. Check read_todos first. A conflict means subsequent edits must be preserved, not overwritten through another tool.',
  parse: value => { const input = object(value); keys(input, ['revision']); return { revision: string(input.revision, 'revision') }; },
  handler: async (context, request) => JSON.stringify(await context.todos.undoTodos(request)),
  describeAction: () => '撤销最近一次聊天调整 · 任务/TODO.md',
});
