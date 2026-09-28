import { TodoService, type TodoStorage } from '@/core/note/TodoService';

function fixture() {
  let text = '# TODO\n## 任务清单\n- [ ] Read textbook\n- [ ] Build experiment\n';
  let history = '';
  const storage: TodoStorage = {
    read: async () => text,
    compareAndSwap: async (before, after) => {
      if (text !== before) throw new Error('Concurrent edit');
      text = after;
    },
    readHistory: async () => history,
    writeHistory: async value => { history = value; },
  };
  return { storage, service: new TodoService(storage), content: () => text, edit: (value: string) => { text = value; } };
}

describe('TODO transactions', () => {
  it('writes nothing if a later operation fails or backup persistence fails', async () => {
    const f = fixture();
    const before = await f.service.readTodos({});
    const original = f.content();
    await expect(f.service.changeTodos({ revision: before.revision, summary: 'Invalid batch', operations: [
      { op: 'update', id: before.tasks[0].id, changes: { status: 'done' } },
      { op: 'move', id: before.tasks[1].id, targetId: 'missing', position: 'before' },
    ] })).rejects.toThrow();
    expect(f.content()).toBe(original);
    f.storage.writeHistory = async () => { throw new Error('Disk full'); };
    await expect(f.service.changeTodos({ revision: before.revision, summary: 'Add', operations: [{ op: 'add', task: { content: 'New' } }] })).rejects.toThrow('Disk full');
    expect(f.content()).toBe(original);
  });

  it('recovers undo when recording a successful commit was interrupted', async () => {
    const f = fixture();
    const original = f.content();
    const persist = f.storage.writeHistory;
    let calls = 0;
    f.storage.writeHistory = async value => { if (++calls === 2) throw new Error('Interrupted'); await persist(value); };
    const before = await f.service.readTodos({});
    const changed = await f.service.changeTodos({ revision: before.revision, summary: 'Add', operations: [{ op: 'add', task: { content: 'New' } }] });
    const reloaded = new TodoService(f.storage);
    expect((await reloaded.readTodos({})).undoAvailable).toBe(true);
    await reloaded.undoTodos({ revision: changed.revision });
    expect(f.content()).toBe(original);
  });

  it('allows only one writer with a given revision and supports consecutive undo', async () => {
    const f = fixture();
    const original = f.content();
    const before = await f.service.readTodos({});
    const writes = await Promise.allSettled(['A', 'B'].map(content => f.service.changeTodos({ revision: before.revision, summary: content, operations: [{ op: 'add', task: { content } }] })));
    expect(writes.map(write => write.status)).toEqual(['fulfilled', 'rejected']);
    const first = await f.service.readTodos({});
    const second = await f.service.changeTodos({ revision: first.revision, summary: 'C', operations: [{ op: 'add', task: { content: 'C' } }] });
    const undone = await f.service.undoTodos({ revision: second.revision });
    expect(undone.revision).toBe(first.revision);
    await f.service.undoTodos({ revision: undone.revision });
    expect(f.content()).toBe(original);
  });
  it('commits a batch atomically and restores the exact original after reloading the service', async () => {
    const f = fixture();
    const original = f.content();
    const before = await f.service.readTodos({});
    const changed = await f.service.changeTodos({ revision: before.revision, summary: 'Split and postpone', operations: [
      { op: 'split', id: before.tasks[0].id, tasks: [{ content: 'Read section 1' }, { content: 'Work example' }] },
      { op: 'update', id: before.tasks[1].id, changes: { status: 'paused' } },
    ] });
    expect(changed.tasks.map(task => task.status)).toEqual(['pending', 'pending', 'paused']);
    await new TodoService(f.storage).undoTodos({ revision: changed.revision });
    expect(f.content()).toBe(original);
  });

  it('rejects stale writes and undo after a manual edit without replacing user content', async () => {
    const f = fixture();
    const before = await f.service.readTodos({});
    await f.service.changeTodos({ revision: before.revision, summary: 'Complete reading', operations: [{ op: 'update', id: before.tasks[0].id, changes: { status: 'done' } }] });
    f.edit(f.content() + 'My new handwritten note.\n');
    const manual = f.content();
    await expect(f.service.changeTodos({ revision: before.revision, summary: 'Stale', operations: [{ op: 'add', task: { content: 'Extra' } }] })).rejects.toThrow(/变化/u);
    await expect(f.service.undoTodos({ revision: (await f.service.readTodos({})).revision })).rejects.toThrow(/变化/u);
    expect(f.content()).toBe(manual);
  });
});
