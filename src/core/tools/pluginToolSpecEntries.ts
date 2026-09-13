import { BROWSE_TOOL_SPEC } from '../library/BrowseTool';
import { CITE_TOOL_SPEC } from '../library/CiteTool';
import { SET_PAPER_FIELDS_TOOL_SPEC } from '../note/SetPaperFieldsTool';
import { WRITE_NOTE_TOOL_SPEC } from '../note/WriteNoteTool';
import { PAPER_READ_TOOL_SPEC } from '../paper/PaperReadTool';
import { SEARCH_TOOL_SPEC } from '../search/SearchTool';
import type { ErasedTool } from './ToolSpec';

/**
 * Raw catalog contents, ordered by tool name.
 *
 * Deliberately kept apart from the validated catalog in `pluginToolSpecs.ts` so
 * the tool-catalog gate can inspect an invalid catalog and report it, instead of
 * crashing while importing it.
 */
export const PLUGIN_TOOL_SPEC_ENTRIES: readonly ErasedTool[] = [
  BROWSE_TOOL_SPEC,
  CITE_TOOL_SPEC,
  PAPER_READ_TOOL_SPEC,
  SEARCH_TOOL_SPEC,
  SET_PAPER_FIELDS_TOOL_SPEC,
  WRITE_NOTE_TOOL_SPEC,
];

/**
 * Tool names retired while consolidating capabilities into the plugin. They are
 * kept as an explicit deny-list so a stale prompt, skill, or MCP config cannot
 * silently reintroduce the old multi-layer toolchain.
 *
 * `read_note` is listed even though it never shipped: reading a card is already
 * covered by the host's own Read tool, so shipping it would duplicate a host
 * capability instead of adding one.
 */
export const RETIRED_PLUGIN_TOOL_NAMES: readonly string[] = [
  'read_note',
  'read_paper',
  'read_pdf_pages',
  'paper_parse_status',
  'search_paper',
];
