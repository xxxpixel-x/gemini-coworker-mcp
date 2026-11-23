import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z, ZodRawShape } from 'zod';
import type { RequiredMcpScope } from '../types.js';
import {
  withMcpGuardrails,
  type McpHandlerExtraLike,
  type OutputGuardResolver,
} from './outputGuard.js';

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TShape;
  readonly annotations: McpToolAnnotations;
  /** Marks tools that must NEVER be softened by MCP_TRUST_SANDBOX_HINTS (external write gates). */
  readonly isExternalWriteGate?: boolean;
  readonly preserveAnnotations?: boolean;
  readonly requiredScope?:
    | RequiredMcpScope
    | ((args: z.infer<z.ZodObject<TShape>>) => RequiredMcpScope);
  readonly guard: OutputGuardResolver<z.infer<z.ZodObject<TShape>>>;
  readonly handler: (
    args: z.infer<z.ZodObject<TShape>>,
    extra: McpHandlerExtraLike,
  ) => Promise<unknown> | unknown;
}

/**
 * Open, extensible MCP tool registry.
 *
 * Add any new tool by calling `registry.register({ ... })` inside `src/mcp/tools/`.
 * Supports `trustSandboxHints` to avoid Gemini's repetitive confirmation popups
 * while always preserving confirmation prompts on external write gates (`publish_changes`).
 */
export class McpToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<ZodRawShape>>();

  constructor(private readonly options: { trustSandboxHints?: boolean } = {}) {}

  register<TShape extends ZodRawShape>(definition: ToolDefinition<TShape>): this {
    if (this.tools.has(definition.name)) {
      throw new Error(`Duplicate MCP tool registration: "${definition.name}"`);
    }
    this.tools.set(definition.name, definition as unknown as ToolDefinition<ZodRawShape>);
    return this;
  }

  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  attachToServer(server: McpServer): void {
    for (const def of this.tools.values()) {
      const effectiveAnnotations: McpToolAnnotations = def.isExternalWriteGate
        ? {
            ...def.annotations,
            readOnlyHint: false,
            destructiveHint: true,
          }
        : this.options.trustSandboxHints && !def.preserveAnnotations
          ? {
              ...def.annotations,
              readOnlyHint: true,
              destructiveHint: false,
            }
          : def.annotations;

      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: effectiveAnnotations,
        },
        withMcpGuardrails(def.handler, def.guard, def.requiredScope),
      );
    }
  }
}
