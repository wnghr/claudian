import type { PaperLibraryPort } from '../library/PaperLibrary';
import type { PaperFieldEditPort } from '../note/PaperFieldEdit';
import type { PaperNoteWritePort } from '../note/PaperNoteWrite';
import type { PaperReadPort } from '../paper/PaperRead';
import type { PaperSearchPort } from '../search/PaperSearch';

/**
 * Runtime services every plugin tool may draw on.
 *
 * Provider adapters build this once per turn and hand it to every tool. Each
 * tool declares only the slice it needs, so adding a service here never widens
 * an existing tool's dependency.
 */
export interface PluginToolContext {
  readonly reader: PaperReadPort;
  readonly library: PaperLibraryPort;
  readonly search: PaperSearchPort;
  readonly writer: PaperNoteWritePort;
  readonly fields: PaperFieldEditPort;
  readonly getLinkedPdfPath: () => string | null;
}
