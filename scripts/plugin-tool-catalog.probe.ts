/**
 * Prints the plugin tool catalog as JSON for `check-plugin-tool-catalog.test.mjs`.
 *
 * This is intentionally a real load of the catalog rather than a text scan: the
 * assertions must fail when the catalog itself is invalid, not when a regex
 * stops matching. The raw entry list is inspected (not the validated catalog)
 * so an invalid catalog is reported instead of crashing this probe.
 */
import { collectTools, inspectToolSpecs, toolNameVariants } from '../src/core/tools/ToolSpec';
import {
  PLUGIN_TOOL_SPEC_ENTRIES,
  RETIRED_PLUGIN_TOOL_NAMES,
} from '../src/core/tools/pluginToolSpecEntries';

/** Shell entry points the tool-first consolidation retired from model prompts. */
const SHELL_COMMAND_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '.agents/kb', pattern: /\.agents\/kb/u },
  { label: 'kb.py', pattern: /\bkb\.py\b/u },
  { label: 'mineru-open-api', pattern: /\bmineru-open-api\b/u },
  { label: 'npx', pattern: /\bnpx\b/u },
  { label: 'pdftotext', pattern: /\bpdftotext\b/u },
  { label: 'python', pattern: /\bpython(?:3)?\b/u },
  { label: 'read_paper', pattern: /\bread_paper\b/u },
  { label: 'research_kb', pattern: /\bresearch_kb\b/u },
  { label: 'uvx', pattern: /\buvx\b/u },
];

type PromptField = 'description' | 'instructions' | 'namespaceDescription';

interface Mention {
  readonly field: PromptField;
  readonly name: string;
  readonly tool: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mentionsName(haystack: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'u').test(haystack);
}

const registeredNames = PLUGIN_TOOL_SPEC_ENTRIES.flatMap(tool => toolNameVariants(tool));
const promptFields: readonly PromptField[] = ['description', 'instructions', 'namespaceDescription'];

const retiredNameMentions: Mention[] = [];
const shellCommandMentions: Mention[] = [];
const toolsMissingToolMention: string[] = [];

for (const tool of PLUGIN_TOOL_SPEC_ENTRIES) {
  const surfaces = promptFields.flatMap(field => {
    const text = field === 'instructions' ? tool.instructions : tool[field];
    return typeof text === 'string' && text.length > 0 ? [{ field, text }] : [];
  });

  for (const { field, text } of surfaces) {
    for (const name of RETIRED_PLUGIN_TOOL_NAMES) {
      if (mentionsName(text, name)) {
        retiredNameMentions.push({ field, name, tool: tool.qualifiedName });
      }
    }
    for (const { label, pattern } of SHELL_COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        shellCommandMentions.push({ field, name: label, tool: tool.qualifiedName });
      }
    }
  }

  if (!surfaces.some(({ text }) => registeredNames.some(name => mentionsName(text, name)))) {
    toolsMissingToolMention.push(tool.qualifiedName);
  }
}

let catalogGuard = 'ok';
try {
  collectTools(PLUGIN_TOOL_SPEC_ENTRIES);
} catch (error) {
  catalogGuard = error instanceof Error ? error.message : String(error);
}

process.stdout.write(`${JSON.stringify({
  capabilities: PLUGIN_TOOL_SPEC_ENTRIES.map(tool => tool.capability),
  catalogGuard,
  retiredNameMentions,
  registeredNames,
  shellCommandMentions,
  toolNames: PLUGIN_TOOL_SPEC_ENTRIES.map(tool => tool.qualifiedName),
  toolsMissingToolMention,
  violations: inspectToolSpecs(PLUGIN_TOOL_SPEC_ENTRIES),
}, null, 2)}\n`);
