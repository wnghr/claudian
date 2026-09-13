import {
  editFrontmatterFields,
  paperFieldUpdates,
  validatePaperFieldValue,
} from '@/core/note/PaperFieldEdit';

const CARD_TEXT = [
  '---',
  'title: Light-driven dancing',
  'id: citeX',
  'status: unread',
  'tags:',
  '  - literature_note',
  '---',
  '',
  '## 讨论与理解',
  '',
  '已有分析。',
  '',
].join('\n');

describe('editFrontmatterFields', () => {
  it('replaces an existing key in place and preserves everything else byte-for-byte', () => {
    const outcome = editFrontmatterFields(CARD_TEXT, [{ key: 'status', value: 'reading' }]);

    expect(outcome.text).toBe(CARD_TEXT.replace('status: unread', 'status: reading'));
    expect(outcome.changed).toEqual([{ from: 'unread', key: 'status', to: 'reading' }]);
    expect(outcome.unchanged).toEqual([]);
  });

  it('appends a missing key before the closing fence', () => {
    const outcome = editFrontmatterFields(CARD_TEXT, [
      { key: 'domain', value: '液晶与软物质' },
    ]);

    expect(outcome.text).toContain('  - literature_note\ndomain: 液晶与软物质\n---');
    expect(outcome.changed).toEqual([{ from: null, key: 'domain', to: '液晶与软物质' }]);
  });

  it('prepends a fresh frontmatter block to a note without one', () => {
    const outcome = editFrontmatterFields('# 纯笔记\n', [{ key: 'status', value: 'read' }]);

    expect(outcome.text).toBe('---\nstatus: read\n---\n\n# 纯笔记\n');
  });

  it('is an honest no-op when every value already holds', () => {
    const outcome = editFrontmatterFields(CARD_TEXT, [{ key: 'status', value: 'unread' }]);

    expect(outcome.text).toBe(CARD_TEXT);
    expect(outcome.changed).toEqual([]);
    expect(outcome.unchanged).toEqual(['status']);
  });

  it('splits a mixed request into changes and no-ops', () => {
    const outcome = editFrontmatterFields(CARD_TEXT, [
      { key: 'status', value: 'unread' },
      { key: 'domain', value: '液晶与软物质' },
    ]);

    expect(outcome.unchanged).toEqual(['status']);
    expect(outcome.changed).toEqual([{ from: null, key: 'domain', to: '液晶与软物质' }]);
    expect(outcome.text).toContain('domain: 液晶与软物质');
    expect(outcome.text).toContain('status: unread');
  });

  it('preserves CRLF endings when replacing and appending', () => {
    const crlf = CARD_TEXT.replace(/\n/gu, '\r\n');
    const outcome = editFrontmatterFields(crlf, [
      { key: 'status', value: 'read' },
      { key: 'domain', value: '液晶' },
    ]);

    expect(outcome.text).toContain('status: read\r\n');
    expect(outcome.text).toContain('  - literature_note\r\ndomain: 液晶\r\n---');
    expect(outcome.text).not.toContain('\n-\n');
  });

  it('takes a block list with it when overwriting an empty-valued key', () => {
    const withList = CARD_TEXT.replace('status: unread', 'domain:\n  - 旧领域');
    const outcome = editFrontmatterFields(withList, [{ key: 'domain', value: '液晶与软物质' }]);

    expect(outcome.text).toContain('domain: 液晶与软物质');
    expect(outcome.text).not.toContain('旧领域');
    expect(outcome.changed).toEqual([{ from: '（列表值）', key: 'domain', to: '液晶与软物质' }]);
  });

  it('quotes values that a bare scalar would render ambiguous', () => {
    const outcome = editFrontmatterFields(CARD_TEXT, [{ key: 'domain', value: 'a: b' }]);

    expect(outcome.text).toContain('domain: "a: b"');
  });
});

describe('validatePaperFieldValue', () => {
  it('accepts the status vocabulary case-insensitively and normalizes it', () => {
    expect(validatePaperFieldValue('status', 'READ')).toEqual({ value: 'read' });
    expect(validatePaperFieldValue('status', 'cited')).toEqual({ value: 'cited' });
  });

  it('rejects an off-list status in the old CLI wording', () => {
    expect(validatePaperFieldValue('status', 'skimmed'))
      .toEqual({ error: 'status 只能是 unread, reading, read, cited' });
  });

  it('rejects classification values with separators or newlines', () => {
    for (const bad of ['光子/晶体', '光#子', '光[子]', '光子\n晶体', '']) {
      expect(validatePaperFieldValue('domain', bad)).toHaveProperty('error');
    }
  });

  it('accepts a plain Chinese noun phrase', () => {
    expect(validatePaperFieldValue('subfield', '液晶斯格明子')).toEqual({ value: '液晶斯格明子' });
  });
});

describe('paperFieldUpdates', () => {
  it('collects only the provided fields in status, domain, subfield order', () => {
    expect(paperFieldUpdates({ domain: '液晶', status: 'READ', target: 'x' })).toEqual([
      { key: 'status', value: 'read' },
      { key: 'domain', value: '液晶' },
    ]);
  });

  it('throws on a value the retired CLI would have rejected', () => {
    expect(() => paperFieldUpdates({ status: 'skimmed', target: 'x' }))
      .toThrow('status 只能是 unread, reading, read, cited');
  });
});
