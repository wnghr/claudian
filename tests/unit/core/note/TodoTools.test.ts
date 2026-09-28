import { TodoService } from '@/core/note/TodoService';
import { CHANGE_TODOS_TOOL_SPEC, parseTodoChange, READ_TODOS_TOOL_SPEC, UNDO_TODOS_TOOL_SPEC } from '@/core/note/TodoTools';

describe('chat TODO tools', () => {
  it('reads, changes and undoes the same list through the confirmed tool contract', async () => {
    let text = '## 任务清单\n- [ ] Jones\n';
    const original = text;
    let history = '';
    const context = {
      todos: new TodoService({
        read: async () => text,
        compareAndSwap: async (before, after) => { if (text !== before) throw new Error('Conflict'); text = after; },
        readHistory: async () => history, writeHistory: async value => { history = value; },
      }),
      confirmToolAction: jest.fn().mockResolvedValue(true),
    };
    const before = JSON.parse(await READ_TODOS_TOOL_SPEC.invoke(context, {}));
    const changed = JSON.parse(await CHANGE_TODOS_TOOL_SPEC.invoke(context, {
      revision: before.revision, summary: 'Complete Jones',
      operations: JSON.stringify([{ op: 'update', id: before.tasks[0].id, changes: { status: 'done' } }]),
    }));
    expect(changed.tasks[0].status).toBe('done');
    expect(context.confirmToolAction).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('Complete Jones') }));
    const approval = context.confirmToolAction.mock.calls[0][0];
    expect(CHANGE_TODOS_TOOL_SPEC.describeAction(approval.input)).toContain('Complete Jones');
    context.confirmToolAction.mockResolvedValue(false);
    await expect(UNDO_TODOS_TOOL_SPEC.invoke(context, { revision: changed.revision })).rejects.toThrow('User denied');
    expect(text).not.toBe(original);
    context.confirmToolAction.mockResolvedValue(true);
    await UNDO_TODOS_TOOL_SPEC.invoke(context, { revision: changed.revision });
    expect(text).toBe(original);
  });

  it('rejects malformed batches and identity injection', () => {
    const parse = (operations: unknown) => parseTodoChange({ revision: 'current', summary: 'Change', operations: JSON.stringify(operations) });
    expect(() => parse([])).toThrow();
    expect(() => parse([{ op: 'delete', id: 'one' }])).toThrow();
    expect(() => parse([{ op: 'update', id: 'one', changes: { id: 'other' } }])).toThrow();
    expect(() => parse([{ op: 'update', id: 'one', changes: { due: null } }])).toThrow();
    expect(() => parse([{ op: 'move', id: 'one', targetId: 'two', position: 'middle' }])).toThrow();
  });
});
