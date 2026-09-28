import { applyTodoOperations, readTodoDocument } from '@/core/note/TodoDocument';

const source = '# TODO\n\n## 任务清单\n\n<!-- todo-project: Optics -->\n- [x] Jones ✅ 2026-09-20\n\n<!-- todo-project: Optics -->\n- [ ] Stokes [[Book#Section 3]]\n  Handwritten derivation stays here.\n\n- [ ] Measurement\n\n## Notes\nKeep this paragraph.\n';

describe('TODO document operations', () => {
  it('adds a batch and merges related steps without discarding their sources or notes', () => {
    const before = readTodoDocument(source);
    const result = applyTodoOperations(source, [
      { op: 'merge', ids: [before.tasks[1].id, before.tasks[2].id], task: { content: 'Stokes and measurement', project: 'Optics' } },
      { op: 'add', task: { content: 'Compare results', project: 'Optics' } },
    ]);
    expect(readTodoDocument(result).tasks.map(task => task.content)).toEqual(['Jones', 'Stokes and measurement', 'Compare results']);
    expect(result).toContain('[[Book#Section 3]]');
    expect(result).toContain('Handwritten derivation stays here.');
    expect(result).toContain('Measurement');
    expect(() => applyTodoOperations(source, [{ op: 'merge', ids: before.tasks.slice(0, 2).map(task => task.id), task: { content: 'Combined' } }])).toThrow(/完成/u);
  });
  it('edits, reorders and pauses steps as one change without losing stable identity', () => {
    const before = readTodoDocument(source);
    const result = applyTodoOperations(source, [
      { op: 'update', id: before.tasks[1].id, changes: { content: 'Stokes examples', due: '2026-10-01' } },
      { op: 'move', id: before.tasks[2].id, targetId: before.tasks[1].id, position: 'before' },
      { op: 'update', id: before.tasks[2].id, changes: { status: 'paused' } },
    ]);
    const after = readTodoDocument(result).tasks;
    expect(after.map(task => task.content)).toEqual(['Jones', 'Measurement', 'Stokes examples']);
    expect(after[1]).toMatchObject({ id: before.tasks[2].id, status: 'paused' });
    expect(after[2]).toMatchObject({ id: before.tasks[1].id, due: '2026-10-01' });
    expect(result).toContain('Handwritten derivation stays here.');
  });
  it('splits an unfinished learning step while preserving completed work, sources and handwritten details', () => {
    const before = readTodoDocument(source);
    const result = applyTodoOperations(source, [{
      op: 'split', id: before.tasks[1].id,
      tasks: [{ content: 'Derive Stokes [[Book#Section 3]]' }, { content: 'Calculate circular polarization' }],
    }]);
    const after = readTodoDocument(result);
    expect(after.tasks.map(task => task.content)).toEqual([
      'Jones', 'Derive Stokes [[Book#Section 3]]', 'Calculate circular polarization', 'Measurement',
    ]);
    expect(after.tasks[1].id).toBe(before.tasks[1].id);
    expect(after.tasks.slice(1, 3).map(task => task.project)).toEqual(['Optics', 'Optics']);
    expect(result).toContain('- [x] Jones ✅ 2026-09-20');
    expect(result).toContain('Handwritten derivation stays here.');
    expect(result).toContain('Stokes [[Book#Section 3]]');
    expect(result.endsWith('## Notes\nKeep this paragraph.\n')).toBe(true);
  });
});
