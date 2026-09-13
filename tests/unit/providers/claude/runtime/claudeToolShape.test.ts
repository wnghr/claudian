import * as z from 'zod/v4';

import { PAPER_READ_TOOL_SPEC } from '@/core/paper/PaperReadTool';
import { toClaudeToolShape } from '@/providers/claude/runtime/claudeToolShape';

describe('claudeToolShape', () => {
  // Wrapping the derived shape is what the agent SDK does internally, so this
  // exercises the same path read_pdf takes at runtime.
  const shape = toClaudeToolShape(PAPER_READ_TOOL_SPEC.fields);
  const schema = z.object(shape);

  it('derives one optional entry per declared field, in declaration order', () => {
    expect(Object.keys(shape)).toEqual(['path', 'pages', 'section', 'query', 'maxChars']);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('enforces the numeric bounds declared on the specification', () => {
    expect(schema.safeParse({ maxChars: 500 }).success).toBe(false);
    expect(schema.safeParse({ maxChars: 1000 }).success).toBe(true);
    expect(schema.safeParse({ maxChars: 50000 }).success).toBe(true);
    expect(schema.safeParse({ maxChars: 50001 }).success).toBe(false);
  });

  it('rejects a wrongly typed field', () => {
    expect(schema.safeParse({ pages: 2 }).success).toBe(false);
    expect(schema.safeParse({ pages: '2' }).success).toBe(true);
  });

  it('marks only the fields the specification left optional as optional', () => {
    const strict = z.object(toClaudeToolShape([
      { name: 'path', type: 'string', description: 'Required field.' },
      { name: 'flags', type: 'boolean', optional: true, description: 'Optional field.' },
    ]));

    expect(strict.safeParse({ path: 'a.pdf' }).success).toBe(true);
    expect(strict.safeParse({ path: 'a.pdf', flags: true }).success).toBe(true);
    expect(strict.safeParse({ flags: true }).success).toBe(false);
  });
});
