import { createHash, randomUUID } from 'node:crypto';

export type TodoStatus = 'pending' | 'done' | 'paused';
export interface TodoDraft {
  content: string;
  project?: string;
  due?: string;
  status?: TodoStatus;
}
export interface TodoTask extends TodoDraft {
  id: string;
  status: TodoStatus;
  details: string;
}
export interface TodoSnapshot {
  revision: string;
  tasks: TodoTask[];
}
export type TodoOperation =
  | { op: 'add'; task: TodoDraft }
  | { op: 'merge'; ids: string[]; task: TodoDraft }
  | { op: 'split'; id: string; tasks: TodoDraft[] }
  | { op: 'update'; id: string; changes: Partial<TodoDraft> }
  | { op: 'move'; id: string; targetId: string; position: 'before' | 'after' };

interface Block { lines: string[]; taskLine: number; task: TodoTask }
const identity = /\s*<!-- todo-id: ([\w-]+) -->/u;
const paused = /\s*<!-- todo-paused -->/u;
const taskPattern = /^- \[([ xX])\] (.+)$/u;
const metadata = /^\s*<!-- (?:kb:.*|todo-project:.*|todo-category:.*)-->\s*$/u;

export function todoRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseDocument(text: string) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  const section = lines.indexOf('## 任务清单');
  if (section < 0) throw new Error('TODO 缺少“任务清单”标题。');
  let end = lines.findIndex((line, i) => i > section && /^#{1,2} /u.test(line));
  if (end < 0) end = lines.length;
  const taskLines: number[] = [];
  let fence = '';
  for (let i = section + 1; i < end; i++) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(lines[i]);
    if (marker) { fence = fence ? '' : marker[1]; continue; }
    if (!fence && taskPattern.test(lines[i])) taskLines.push(i);
  }
  const starts = taskLines.map((line, index) => {
    let start = line;
    const minimum = index ? taskLines[index - 1] + 1 : section + 1;
    while (start > minimum && (!lines[start - 1].trim() || metadata.test(lines[start - 1]))) start--;
    return start;
  });
  let last = end;
  if (taskLines.length) while (last > taskLines.at(-1)! + 1 && !lines[last - 1].trim()) last--;
  const occurrences = new Map<string, number>();
  const blocks: Block[] = taskLines.map((line, index) => {
    const match = taskPattern.exec(lines[line])!;
    const raw = match[2];
    const count = occurrences.get(raw) ?? 0;
    occurrences.set(raw, count + 1);
    const id = identity.exec(raw)?.[1] ?? `legacy-${todoRevision(`${raw}:${count}`).slice(0, 20)}`;
    const project = lines.slice(starts[index], line).map(value => /<!-- todo-project: (.*?) -->/u.exec(value)?.[1]).find(Boolean);
    const body = raw.replace(identity, '').replace(paused, '');
    const due = /📅 (\d{4}-\d{2}-\d{2})/u.exec(body)?.[1];
    return {
      lines: lines.slice(starts[index], starts[index + 1] ?? last), taskLine: line - starts[index],
      task: {
        id, content: body.replace(/\s*(?:📅|✅) \d{4}-\d{2}-\d{2}/gu, '').trim(),
        project, due, status: match[1].toLowerCase() === 'x' ? 'done' : paused.test(raw) ? 'paused' : 'pending',
        details: lines.slice(line + 1, starts[index + 1] ?? last).join('\n').trim(),
      },
    };
  });
  if (new Set(blocks.map(block => block.task.id)).size !== blocks.length) throw new Error('任务标识重复，请先检查清单。');
  return { eol, prefix: lines.slice(0, starts[0] ?? end), suffix: lines.slice(taskLines.length ? last : end), blocks };
}

export function readTodoDocument(text: string): TodoSnapshot {
  return { revision: todoRevision(text), tasks: parseDocument(text).blocks.map(block => block.task) };
}

function validateDraft(task: TodoDraft) {
  if (!task || typeof task.content !== 'string' || !task.content.trim() || /[\r\n]|<!--|^- \[/u.test(task.content)) {
    throw new Error('任务内容必须是非空单行正文，不含任务框或隐藏标记。');
  }
  if (task.project !== undefined && (typeof task.project !== 'string' || task.project.length > 80 || /[<>\r\n]|--/u.test(task.project))) {
    throw new Error('项目标签无效。');
  }
  if (task.due && (!/^\d{4}-\d{2}-\d{2}$/u.test(task.due) || Number.isNaN(Date.parse(task.due)) || new Date(task.due).toISOString().slice(0, 10) !== task.due)) {
    throw new Error('截止日期必须是有效的 YYYY-MM-DD。');
  }
  if (task.status && !['pending', 'done', 'paused'].includes(task.status)) throw new Error('任务状态无效。');
}

function renderBlock(block: Block, changes: Partial<TodoDraft>, today: string): Block {
  const task = { ...block.task, ...changes };
  validateDraft(task);
  const lines = [...block.lines];
  let taskLine = block.taskLine;
  if (changes.project !== undefined) {
    const marker = lines.findIndex((line, i) => i < taskLine && /<!-- todo-project:/u.test(line));
    if (marker >= 0) { lines.splice(marker, 1); taskLine--; }
    if (task.project) { lines.splice(taskLine, 0, `<!-- todo-project: ${task.project} -->`); taskLine++; }
  }
  const completed = /✅ (\d{4}-\d{2}-\d{2})/u.exec(block.lines[block.taskLine])?.[1] ?? today;
  lines[taskLine] = `- [${task.status === 'done' ? 'x' : ' '}] ${task.content}${task.due ? ` 📅 ${task.due}` : ''}${task.status === 'done' ? ` ✅ ${completed}` : ''} <!-- todo-id: ${task.id} -->${task.status === 'paused' ? ' <!-- todo-paused -->' : ''}`;
  return { lines, taskLine, task };
}

function newBlock(draft: TodoDraft, today: string): Block {
  return renderBlock({ lines: ['', '- [ ] placeholder'], taskLine: 1, task: { ...draft, id: randomUUID(), status: draft.status ?? 'pending', details: '' } }, draft, today);
}

export function applyTodoOperations(text: string, operations: readonly TodoOperation[], today = new Date().toLocaleDateString('en-CA')): string {
  const doc = parseDocument(text);
  // Pin legacy identities on the first mutation, including indistinguishable duplicates.
  for (const block of doc.blocks) {
    if (!identity.test(block.lines[block.taskLine])) block.lines[block.taskLine] += ` <!-- todo-id: ${block.task.id} -->`;
  }
  for (const operation of operations) {
    if (operation.op === 'add') {
      validateDraft(operation.task);
      if (doc.blocks.some(block => block.task.content === operation.task.content.trim() && (block.task.project ?? '') === (operation.task.project ?? ''))) {
        throw new Error('已有相同任务，请修改原任务或移除重复项。');
      }
      doc.blocks.push(newBlock(operation.task, today));
      continue;
    }
    if (operation.op === 'merge') {
      if (new Set(operation.ids).size !== operation.ids.length || operation.ids.length < 2) throw new Error('合并需要至少两个不同任务。');
      const selected = operation.ids.map(id => doc.blocks.find(block => block.task.id === id));
      if (selected.some(block => !block)) throw new Error('合并任务不存在。');
      const originals = selected as Block[];
      if (originals.some(block => block.task.status === 'done')) throw new Error('请保留已完成记录，只合并未完成任务。');
      const firstIndex = Math.min(...originals.map(block => doc.blocks.indexOf(block)));
      const first = doc.blocks[firstIndex];
      const merged = renderBlock(first, operation.task, today);
      for (const block of originals) {
        merged.lines.push(`  合并前：${block.lines[block.taskLine].replace(identity, '').replace(paused, '')}`);
        if (block !== first) merged.lines.push(...block.lines.slice(block.taskLine + 1));
      }
      doc.blocks = doc.blocks.filter(block => !operation.ids.includes(block.task.id));
      doc.blocks.splice(firstIndex, 0, merged);
      continue;
    }
    const index = doc.blocks.findIndex(block => block.task.id === operation.id);
    if (index < 0) throw new Error('任务已改变或不存在，请重新读取 TODO。');
    const original = doc.blocks[index];
    if (operation.op === 'update') {
      doc.blocks[index] = renderBlock(original, operation.changes, today);
      continue;
    }
    if (operation.op === 'move') {
      if (operation.id === operation.targetId) throw new Error('不能相对自己移动任务。');
      if (!doc.blocks.some(block => block.task.id === operation.targetId)) throw new Error('目标任务不存在。');
      const [moving] = doc.blocks.splice(index, 1);
      const target = doc.blocks.findIndex(block => block.task.id === operation.targetId);
      doc.blocks.splice(target + (operation.position === 'after' ? 1 : 0), 0, renderBlock(moving, {}, today));
      continue;
    }
    if (original.task.status === 'done') throw new Error('已完成任务不能拆分；请保留记录或明确重新打开。');
    if (!Array.isArray(operation.tasks) || operation.tasks.length < 2) throw new Error('拆分至少需要两个步骤。');
    const children = operation.tasks.map((draft, i) => i === 0
      ? renderBlock(original, draft, today)
      : newBlock({ project: original.task.project, due: original.task.due, status: original.task.status, ...draft }, today));
    children[0].lines.push(`  原任务：${original.task.content}`);
    doc.blocks.splice(index, 1, ...children);
  }
  return [...doc.prefix, ...doc.blocks.flatMap(block => block.lines), ...doc.suffix].join(doc.eol);
}
