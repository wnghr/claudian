import type { PaperFieldEditPort } from '../note/PaperFieldEdit';
import type { PaperNoteWritePort } from '../note/PaperNoteWrite';
import type { PaperReadPort } from '../paper/PaperRead';
import type { PaperSearchPort } from '../search/PaperSearch';

export interface PluginToolConfirmationRequest {
  readonly toolName: string;
  readonly actionLabel: string;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Runtime services every plugin tool may draw on.
 *
 * Provider adapters build this once per turn and hand it to every tool. Each
 * tool declares only the slice it needs, so adding a service here never widens
 * an existing tool's dependency.
 */
export interface PluginToolContext {
  readonly reader: PaperReadPort;
  readonly search: PaperSearchPort;
  readonly writer: PaperNoteWritePort;
  readonly fields: PaperFieldEditPort;
  readonly getLinkedPaperPath: () => string | null;
  /** Plugin-owned confirmation; host/provider approval is not a safety net. */
  readonly confirmToolAction: (
    request: PluginToolConfirmationRequest,
  ) => Promise<boolean>;
}
