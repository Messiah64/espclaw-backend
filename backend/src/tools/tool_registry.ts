import type { AssistantToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolRiskLevel } from "../types/assistant.js";

export type ToolHandler = (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;

export type RegisteredTool = AssistantToolDefinition & {
  handler: ToolHandler;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): AssistantToolDefinition[] {
    return [...this.tools.values()].map(({ handler: _handler, ...definition }) => definition);
  }

  openAiTools(): Array<Record<string, unknown>> {
    return this.list().map((tool) => ({
      type: "function",
      name: tool.name,
      description: `${tool.description} Risk: ${tool.risk}.`,
      parameters: tool.parameters
    }));
  }

  async run(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, text: `Unknown tool: ${name}` };
    return tool.handler(args, context);
  }
}

export function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function risk(_level: ToolRiskLevel): ToolRiskLevel {
  return _level;
}

