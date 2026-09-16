import {
  executeWriteTodoTool,
  parseWriteTodoToolInput,
  TODO_NOTE_PATH,
  TODO_NOTE_SECTION,
} from '@/core/note/WriteTodoTool';

describe('write_todo tool', () => {
  it('writes one unchecked task to the unified TODO note', async () => {
    const writer = {
      appendToNote: jest.fn().mockResolvedValue({
        action: 'appended',
        path: TODO_NOTE_PATH,
        link: '[[任务/TODO]]',
        location: `§ ${TODO_NOTE_SECTION}`,
        backupPath: 'D:/research/note-edit-backups/TODO.md',
      }),
    };

    const result = await executeWriteTodoTool(writer, {
      content: '整理本周实验数据',
      due: '2026-09-20',
    });

    expect(writer.appendToNote).toHaveBeenCalledWith({
      target: TODO_NOTE_PATH,
      section: TODO_NOTE_SECTION,
      content: '- [ ] 整理本周实验数据 📅 2026-09-20',
    });
    expect(result).toContain('已加入 TODO');
    expect(result).toContain('任务/TODO.md');
  });

  it('rejects empty tasks and malformed due dates', () => {
    expect(() => parseWriteTodoToolInput({ content: '   ' })).toThrow(/content/u);
    expect(() => parseWriteTodoToolInput({ content: '读论文', due: '明天' })).toThrow(/YYYY-MM-DD/u);
  });

  it('strips a pasted checkbox so every written task has one canonical shape', () => {
    expect(parseWriteTodoToolInput({ content: '- [x] 已经勾选的任务' })).toEqual({
      content: '已经勾选的任务',
    });
  });
});
