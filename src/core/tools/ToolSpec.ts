/**
 * Declarative, transport-neutral tool specifications.
 *
 * A Claudian tool is described exactly once. Provider adapters (the Claude
 * in-process MCP server, the Codex dynamic tool registry) derive their own
 * transport shape from the same spec, and approval rendering reads the same
 * fields, so a tool cannot drift between providers.
 *
 * Capability delivery rule: a tool is the only way to perform an operation.
 * Instruction strings may name tools, never shell commands.
 */

export type ToolFieldType = 'string' | 'number' | 'boolean';

export interface ToolFieldSpec {
  readonly name: string;
  readonly type: ToolFieldType;
  readonly description: string;
  readonly optional?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** Whether calling the tool can change files, the vault, or remote state. */
export type ToolExecutionClass = 'read' | 'write';

export interface ToolJsonSchemaProperty {
  readonly type: ToolFieldType;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description: string;
}

export interface ToolJsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolJsonSchemaProperty>>;
  readonly additionalProperties: false;
}

export interface ToolSpec<Input, Context> {
  readonly namespace: string;
  readonly namespaceDescription: string;
  readonly name: string;
  readonly version: number;
  readonly description: string;
  /** Exactly one capability slot per tool; two tools may never share a slot. */
  readonly capability: string;
  /** Short human verb phrase used in approval prompts, for example `Read PDF`. */
  readonly actionLabel: string;
  readonly executionClass: ToolExecutionClass;
  /**
   * Write tools must be confirmed by the plugin itself: host approval can be
   * bypassed entirely (Claudian `yolo` mode), so it is not a safety net.
   */
  readonly requiresConfirmation: boolean;
  readonly fields: readonly ToolFieldSpec[];
  /** Appended to the system prompt. Names tools, never shell commands. */
  readonly instructions?: string;
  readonly parse: (value: unknown) => Input;
  readonly handler: (context: Context, input: Input) => Promise<string>;
  /** Human-readable action line for approval prompts and audit trails. */
  readonly describeAction: (input: Input) => string;
}

/** Transport-neutral tool view consumed by registries and provider adapters. */
export interface ErasedTool {
  readonly namespace: string;
  readonly namespaceDescription: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly version: number;
  readonly description: string;
  readonly capability: string;
  readonly actionLabel: string;
  readonly executionClass: ToolExecutionClass;
  readonly requiresConfirmation: boolean;
  readonly fields: readonly ToolFieldSpec[];
  readonly jsonSchema: ToolJsonSchema;
  readonly instructions: string | null;
  invoke(context: unknown, args: unknown): Promise<string>;
  describeAction(args: unknown): string;
}

export function toJsonSchema(fields: readonly ToolFieldSpec[]): ToolJsonSchema {
  const properties: Record<string, ToolJsonSchemaProperty> = {};
  for (const field of fields) {
    properties[field.name] = {
      type: field.type,
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      description: field.description,
    };
  }
  return { type: 'object', properties, additionalProperties: false };
}

export function defineTool<Input, Context>(spec: ToolSpec<Input, Context>): ErasedTool {
  return {
    namespace: spec.namespace,
    namespaceDescription: spec.namespaceDescription,
    name: spec.name,
    qualifiedName: `${spec.namespace}.${spec.name}`,
    version: spec.version,
    description: spec.description,
    capability: spec.capability,
    actionLabel: spec.actionLabel,
    executionClass: spec.executionClass,
    requiresConfirmation: spec.requiresConfirmation,
    fields: spec.fields,
    jsonSchema: toJsonSchema(spec.fields),
    instructions: spec.instructions ?? null,
    invoke: (context, args) => spec.handler(context as Context, spec.parse(args)),
    describeAction: args => {
      try {
        return spec.describeAction(spec.parse(args));
      } catch {
        return '';
      }
    },
  };
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Structural invariants that keep the catalog collision-free and reviewable.
 * Returns one message per violation so callers can report all of them at once.
 */
export function inspectToolSpecs(tools: readonly ErasedTool[]): string[] {
  const violations: string[] = [];
  const names = new Set<string>();
  const capabilities = new Map<string, string>();
  const namespaceDescriptions = new Map<string, string>();

  for (const tool of tools) {
    // Derived rather than trusted, so a stale denormalized field cannot mask a
    // collision between two specs.
    const qualifiedName = `${tool.namespace}.${tool.name}`;

    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      violations.push(`${qualifiedName}: tool name must be lower_snake_case`);
    }
    if (!CAPABILITY_PATTERN.test(tool.capability)) {
      violations.push(`${qualifiedName}: capability must be dotted lower_snake_case`);
    }
    if (tool.description.trim().length < 40) {
      violations.push(`${qualifiedName}: description must explain when to use the tool`);
    }
    if (tool.namespaceDescription.trim().length === 0) {
      violations.push(`${qualifiedName}: namespace description must not be empty`);
    }
    const describedNamespace = namespaceDescriptions.get(tool.namespace);
    if (describedNamespace === undefined) {
      namespaceDescriptions.set(tool.namespace, tool.namespaceDescription);
    } else if (describedNamespace !== tool.namespaceDescription) {
      // One namespace becomes one MCP server, which carries a single description.
      violations.push(
        `${qualifiedName}: namespace ${tool.namespace} has a conflicting description`,
      );
    }
    if (tool.actionLabel.trim().length === 0) {
      violations.push(`${qualifiedName}: action label must not be empty`);
    }

    if (names.has(qualifiedName)) {
      violations.push(`${qualifiedName}: duplicate tool name`);
    }
    names.add(qualifiedName);

    const capabilityOwner = capabilities.get(tool.capability);
    if (capabilityOwner !== undefined) {
      violations.push(
        `${qualifiedName} and ${capabilityOwner} both claim capability ${tool.capability}`,
      );
    } else {
      capabilities.set(tool.capability, qualifiedName);
    }

    if (tool.executionClass === 'read' && tool.requiresConfirmation) {
      violations.push(`${qualifiedName}: read tools must not require confirmation`);
    }

    const fieldNames = new Set<string>();
    for (const field of tool.fields) {
      if (fieldNames.has(field.name)) {
        violations.push(`${qualifiedName}: duplicate field ${field.name}`);
      }
      fieldNames.add(field.name);
      if (
        (field.minimum !== undefined || field.maximum !== undefined)
        && field.type !== 'number'
      ) {
        violations.push(`${qualifiedName}.${field.name}: numeric bounds need a number field`);
      }
      if (field.description.trim().length === 0) {
        violations.push(`${qualifiedName}.${field.name}: field description must not be empty`);
      }
    }
  }

  return violations;
}

/** Registers a catalog, refusing to load one that violates its invariants. */
export function collectTools(tools: readonly ErasedTool[]): readonly ErasedTool[] {
  const violations = inspectToolSpecs(tools);
  if (violations.length > 0) {
    throw new Error(`Tool catalog is invalid:\n${violations.join('\n')}`);
  }
  return tools;
}

/**
 * Accepts the bare tool name, the `namespace.name` form, and the
 * host-qualified `mcp__namespace__name` form used by Claude MCP servers.
 */
export function toolNameVariants(tool: ErasedTool): readonly string[] {
  return [tool.name, tool.qualifiedName, `mcp__${tool.namespace}__${tool.name}`];
}

export function findToolByActionName(
  tools: readonly ErasedTool[],
  actionName: string,
): ErasedTool | null {
  return tools.find(tool => toolNameVariants(tool).includes(actionName)) ?? null;
}
