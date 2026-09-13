import {
  PLUGIN_TOOL_NAMESPACE,
  PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
} from '../tools/pluginToolNamespace';
import { defineTool, toJsonSchema, type ToolFieldSpec } from '../tools/ToolSpec';
import {
  PAPER_STATUS_VALUES,
  type PaperFieldEditPort,
  type PaperFieldEditResult,
  validatePaperFieldValue,
} from './PaperFieldEdit';

export const SET_PAPER_FIELDS_TOOL_NAME = 'set_paper_fields';
export const SET_PAPER_FIELDS_TOOL_VERSION = 1;
export const SET_PAPER_FIELDS_TOOL_CAPABILITY = 'paper.fields';
export const SET_PAPER_FIELDS_TOOL_ACTION_LABEL = 'Set paper fields';
export const SET_PAPER_FIELDS_TOOL_DESCRIPTION =
  'Update whitelisted frontmatter fields on a paper card in this vault: the reading status '
    + `(${PAPER_STATUS_VALUES.join('/ ')}) and the 领域/子领域 classification. `
    + 'Use it after classifying a newly imported paper or when the reading status changes. '
    + 'Only the provided fields are touched; the rest of the card is preserved byte-for-byte.';
export const SET_PAPER_FIELDS_TOOL_INSTRUCTIONS =
  'Use the Claudian set_paper_fields tool to record reading status and 领域/子领域 classifications '
    + 'on paper cards. Never edit card frontmatter by hand with file tools; '
    + 'set_paper_fields writes only the whitelisted fields.';

const SET_PAPER_FIELDS_TOOL_FIELDS: readonly ToolFieldSpec[] = [
  {
    name: 'target',
    type: 'string',
    description:
      'Which paper card to update: a vault path, a card name, or a citekey. Wiki-link brackets are tolerated.',
  },
  {
    name: 'status',
    type: 'string',
    optional: true,
    description: `New reading status: one of ${PAPER_STATUS_VALUES.join(', ')}.`,
  },
  {
    name: 'domain',
    type: 'string',
    optional: true,
    description: 'New 领域 value — a short Chinese noun phrase without / # [ ].',
  },
  {
    name: 'subfield',
    type: 'string',
    optional: true,
    description: 'New 子领域 value — a short Chinese noun phrase without / # [ ].',
  },
];

export const SET_PAPER_FIELDS_TOOL_JSON_SCHEMA = toJsonSchema(SET_PAPER_FIELDS_TOOL_FIELDS);

export interface SetPaperFieldsToolInput {
  readonly target: string;
  readonly status?: string;
  readonly domain?: string;
  readonly subfield?: string;
}

/** Runtime dependency the field-edit capability needs, supplied by each provider. */
export interface SetPaperFieldsToolContext {
  readonly fields: PaperFieldEditPort;
}

export function parseSetPaperFieldsToolInput(value: unknown): SetPaperFieldsToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('set_paper_fields needs a target and at least one of status, domain, subfield.');
  }
  const input = value as Record<string, unknown>;

  if (typeof input.target !== 'string' || !input.target.trim()) {
    throw new Error('target must be a non-empty card path, name, or citekey.');
  }

  const result: {
    target: string;
    status?: string;
    domain?: string;
    subfield?: string;
  } = { target: input.target.trim() };

  let provided = 0;
  for (const key of ['status', 'domain', 'subfield'] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`${key} must be a non-empty string.`);
    }
    const checked = validatePaperFieldValue(key, raw);
    if ('error' in checked) throw new Error(checked.error);
    result[key] = checked.value;
    provided += 1;
  }
  if (provided === 0) {
    throw new Error('Provide at least one of status, domain, subfield.');
  }
  return result;
}

export function formatPaperFieldEditResult(result: PaperFieldEditResult): string {
  const lines: string[] = [];
  if (result.action === 'updated') {
    lines.push(`已更新 ${result.path}`);
    for (const change of result.changed) {
      lines.push(`  ${change.key}: ${change.from === null ? '（未设置）' : change.from} → ${change.to}`);
    }
  } else {
    lines.push(`字段已是目标值，未改动 ${result.path}`);
  }
  lines.push(`链接：${result.link}`);
  if (result.action === 'updated' && !result.backupPath) {
    lines.push('注意：本次写入没有备份文件。');
  }
  if (result.unchanged.length > 0) {
    lines.push(`未变化字段：${result.unchanged.join('、')}`);
  }
  if (result.alternates && result.alternates.length > 0) {
    lines.push('同名笔记不止一个，已写入第一个；其他匹配：');
    for (const alternate of result.alternates) lines.push(`  · ${alternate}`);
  }
  return lines.join('\n');
}

export async function executeSetPaperFieldsTool(
  fields: PaperFieldEditPort,
  value: unknown,
): Promise<string> {
  const input = parseSetPaperFieldsToolInput(value);
  return formatPaperFieldEditResult(await fields.setPaperFields(input));
}

/** The single definition point for set_paper_fields; provider adapters derive from it. */
export const SET_PAPER_FIELDS_TOOL_SPEC = defineTool<SetPaperFieldsToolInput, SetPaperFieldsToolContext>({
  namespace: PLUGIN_TOOL_NAMESPACE,
  namespaceDescription: PLUGIN_TOOL_NAMESPACE_DESCRIPTION,
  name: SET_PAPER_FIELDS_TOOL_NAME,
  version: SET_PAPER_FIELDS_TOOL_VERSION,
  description: SET_PAPER_FIELDS_TOOL_DESCRIPTION,
  capability: SET_PAPER_FIELDS_TOOL_CAPABILITY,
  actionLabel: SET_PAPER_FIELDS_TOOL_ACTION_LABEL,
  executionClass: 'write',
  requiresConfirmation: true,
  fields: SET_PAPER_FIELDS_TOOL_FIELDS,
  instructions: SET_PAPER_FIELDS_TOOL_INSTRUCTIONS,
  parse: parseSetPaperFieldsToolInput,
  handler: (context, input) => executeSetPaperFieldsTool(context.fields, input),
  describeAction: input => {
    const keys = ['status', 'domain', 'subfield']
      .filter(key => input[key as keyof SetPaperFieldsToolInput] !== undefined);
    return `${input.target} ← ${keys.join(', ')}`;
  },
});
