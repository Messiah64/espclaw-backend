import OpenAI from "openai";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { ToolExecutionContext } from "../types/assistant.js";
import { AuditLogService } from "./audit_log_service.js";
import { MemoryService } from "./memory_service.js";
import { ToolRegistry } from "../tools/tool_registry.js";

export class OpenAIService {
  private readonly client?: OpenAI;

  constructor(
    private readonly config: AppConfig,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryService,
    private readonly audit: AuditLogService,
    private readonly logger: FastifyBaseLogger
  ) {
    this.client = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : undefined;
  }

  async respond(input: {
    userId: string;
    deviceId?: string;
    text: string;
    mode?: "voice" | "deep";
  }): Promise<string> {
    if (!this.client) {
      return "OpenAI is not configured on the backend yet.";
    }

    const model = input.mode === "deep" ? this.config.openaiDeepModel : this.config.openaiFastModel;
    const memories = await this.memory.recall(input.userId);
    const instructions = [
      "You are ESPClaw, a private desktop assistant connected to an ESP32-S3-BOX-3B.",
      "Keep voice replies short, natural, and useful.",
      "Never reveal backend secrets, API keys, tokens, refresh tokens, or internal credentials.",
      "Use tools for Gmail, Calendar, Drive, Contacts, Telegram, and device actions when helpful.",
      "Sensitive writes must go through the permission tool flow and may return pending approval.",
      memories.length ? `Relevant memory: ${memories.map((m) => `${m.key}=${m.value}`).join("; ")}` : ""
    ].filter(Boolean).join("\n");

    const context: ToolExecutionContext = {
      userId: input.userId,
      deviceId: input.deviceId
    };

    let response = await this.client.responses.create({
      model,
      instructions,
      input: input.text,
      tools: this.tools.openAiTools() as never,
      tool_choice: "auto"
    } as never) as any;

    for (let round = 0; round < 4; round++) {
      const calls = (response.output ?? []).filter((item: any) => item.type === "function_call");
      if (!calls.length) break;

      const toolOutputs = [];
      for (const call of calls) {
        const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        await this.audit.record({
          userId: input.userId,
          deviceId: input.deviceId,
          action: `tool.${call.name}`,
          risk: "read_only",
          status: "allowed",
          metadata: { callId: call.call_id }
        });
        const result = await this.tools.run(call.name, args, context);
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }

      response = await this.client.responses.create({
        model,
        instructions,
        previous_response_id: response.id,
        input: toolOutputs,
        tools: this.tools.openAiTools() as never
      } as never) as any;
    }

    const text = response.output_text || "Done.";
    this.logger.info({ model, chars: text.length }, "openai response completed");
    return text;
  }
}

