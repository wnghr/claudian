import {
  appendToNoteText,
  DEFAULT_APPEND_SECTION,
  findSection,
  isDuplicateText,
} from '@/core/note/PaperNoteWrite';

const STAMPED_AT = new Date(2026, 8, 13, 18, 30, 0);
const STAMP = '<!-- kb:20260913-183000 -->';

const CARD = [
  '---',
  'title: Light-driven dancing of nematic colloids',
  'id: citeX',
  '---',
  '',
  '# citeX',
  '',
  '## 想弄懂的问题',
  '',
  '耦合的标度律是什么？',
  '',
  '## 讨论与理解',
  '',
  '弹性各向异性主导了形貌。',
  '',
  '## 我的想法与未解决问题',
  '',
  '等重复实验。',
  '',
].join('\n');

describe('findSection', () => {
  it('finds an exact heading and inserts before the trailing blank lines', () => {
    const section = findSection(CARD, '讨论与理解');

    expect(section).not.toBeNull();
    expect(section?.heading).toBe('讨论与理解');
    expect(section?.level).toBe(2);
    const lines = CARD.split('\n');
    // The section ends right before "## 我的想法与未解决问题".
    const nextHeadingIndex = lines.indexOf('## 我的想法与未解决问题');
    expect(section?.insertIndex).toBe(nextHeadingIndex - 1);
  });

  it('resolves an alias to the canonical section', () => {
    const section = findSection(CARD, '讨论');
    expect(section?.heading).toBe('讨论与理解');

    const ideas = findSection(CARD, '我的想法');
    expect(ideas?.heading).toBe('我的想法与未解决问题');
  });

  it('matches by substring when nothing exact exists', () => {
    const section = findSection(CARD, '讨论与');
    expect(section?.heading).toBe('讨论与理解');
  });

  it('returns null when no heading comes close', () => {
    expect(findSection(CARD, '方法')).toBeNull();
  });
});

describe('isDuplicateText', () => {
  it('detects an already-present block despite case and width drift', () => {
    expect(isDuplicateText(CARD, 'ID: CITEX')).toBe(true);
    expect(isDuplicateText(CARD, '弹性各向异性主导了形貌。')).toBe(true);
    expect(isDuplicateText(CARD, '完全新的观察。')).toBe(false);
  });
});

describe('appendToNoteText', () => {
  it('appends a stamped block at the end of the chosen section and keeps frontmatter bytes', () => {
    const outcome = appendToNoteText(CARD, '界面锚定也参与其中。', {
      section: '讨论与理解',
      now: STAMPED_AT,
    });

    expect(outcome.action).toBe('appended');
    expect(outcome.text.startsWith('---\ntitle: Light-driven dancing of nematic colloids')).toBe(true);
    expect(outcome.text).toContain(`${STAMP}\n界面锚定也参与其中。`);

    const lines = outcome.text.split('\n');
    const blockIndex = lines.indexOf(STAMP);
    const ideasIndex = lines.indexOf('## 我的想法与未解决问题');
    expect(blockIndex).toBeGreaterThan(0);
    expect(blockIndex).toBeLessThan(ideasIndex);
    // The block stays inside the section, above the following heading.
    expect(outcome.location).toContain('讨论与理解');
  });

  it('creates the section when the note has none', () => {
    const note = '---\ntitle: scratch\n---\n\nSome stray thought.\n';
    const outcome = appendToNoteText(note, '补一条记录。', {
      section: '下次从这里继续',
      now: STAMPED_AT,
    });

    expect(outcome.text).toContain('\n\n## 下次从这里继续\n\n');
    expect(outcome.text).toContain(`${STAMP}\n补一条记录。`);
    expect(outcome.location).toContain('新建小节');
  });

  it('skips an identical block unless duplicates are allowed', () => {
    const skipped = appendToNoteText(CARD, '弹性各向异性主导了形貌。', {
      section: DEFAULT_APPEND_SECTION,
      now: STAMPED_AT,
    });
    expect(skipped.action).toBe('duplicate_skipped');
    expect(skipped.text).toBe(CARD);

    const forced = appendToNoteText(CARD, '弹性各向异性主导了形貌。', {
      allowDuplicate: true,
      section: DEFAULT_APPEND_SECTION,
      now: STAMPED_AT,
    });
    expect(forced.action).toBe('appended');
    expect((forced.text.match(new RegExp(STAMP.replaceAll('$', '\\$'), 'gu')) ?? []).length).toBe(1);
  });

  it('rejects empty content', () => {
    expect(() => appendToNoteText(CARD, '   ', {
      section: DEFAULT_APPEND_SECTION,
      now: STAMPED_AT,
    })).toThrow();
  });
});
