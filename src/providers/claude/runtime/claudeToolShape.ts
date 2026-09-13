import * as z from 'zod/v4';

import type { ToolFieldSpec } from '../../../core/tools/ToolSpec';

/**
 * Derives the Claude tool argument shape from the shared declarative field list.
 * The Claude side therefore cannot drift from the Codex JSON schema: both are
 * generated from the same `ToolFieldSpec[]` on the tool specification.
 */
export function toClaudeToolShape(fields: readonly ToolFieldSpec[]): z.core.$ZodShape {
  const shape: Record<string, z.core.$ZodType> = {};
  for (const field of fields) {
    shape[field.name] = toClaudeFieldSchema(field);
  }
  return shape;
}

function toClaudeFieldSchema(field: ToolFieldSpec): z.core.$ZodType {
  switch (field.type) {
    case 'number': {
      let schema = z.number();
      if (field.minimum !== undefined) schema = schema.min(field.minimum);
      if (field.maximum !== undefined) schema = schema.max(field.maximum);
      return field.optional === true ? schema.optional() : schema;
    }
    case 'boolean': {
      const schema = z.boolean();
      return field.optional === true ? schema.optional() : schema;
    }
    default: {
      const schema = z.string();
      return field.optional === true ? schema.optional() : schema;
    }
  }
}
