import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  CODEX_PAPER_READ_TOOL_NAME,
  CODEX_PAPER_READ_TOOL_NAMESPACE,
  createCodexPaperReadTool,
} from '@/providers/codex/runtime/CodexPaperReadTool';

describe('CodexPaperReadTool', () => {
  it('reads the linked PDF through the provider host', async () => {
    const host = {
      readPaper: jest.fn().mockResolvedValue({
        sourcePath: '论文/PDF/current.pdf',
        cachePath: '论文/MD/current/current.paged.md',
        content: '<!-- p.2 -->\nFocused body',
        selection: 'p.2',
        truncated: false,
      }),
    } as unknown as ProviderHost;
    const registration = createCodexPaperReadTool(
      host,
      () => '论文/PDF/current.pdf',
    );

    expect(registration.namespace?.name).toBe(CODEX_PAPER_READ_TOOL_NAMESPACE);
    expect(registration.tool.name).toBe(CODEX_PAPER_READ_TOOL_NAME);
    await expect(registration.handler({
      arguments: { pages: '2' },
      callId: 'call-1',
      namespace: CODEX_PAPER_READ_TOOL_NAMESPACE,
      threadId: 'thread-1',
      tool: CODEX_PAPER_READ_TOOL_NAME,
      turnId: 'turn-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      contentItems: [expect.objectContaining({
        text: expect.stringContaining('Selection: p.2'),
      })],
    }));
    expect(host.readPaper).toHaveBeenCalledWith({
      pages: '2',
      sourcePath: '论文/PDF/current.pdf',
    });
  });

  it('fails clearly when no PDF is linked or supplied', async () => {
    const host = { readPaper: jest.fn() } as unknown as ProviderHost;
    const registration = createCodexPaperReadTool(host, () => null);

    await expect(registration.handler({
      arguments: {},
      callId: 'call-1',
      namespace: CODEX_PAPER_READ_TOOL_NAMESPACE,
      threadId: 'thread-1',
      tool: CODEX_PAPER_READ_TOOL_NAME,
      turnId: 'turn-1',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      contentItems: [expect.objectContaining({
        text: expect.stringContaining('No PDF is linked'),
      })],
    }));
  });
});
