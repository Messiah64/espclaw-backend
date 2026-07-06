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

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private extractText(response: any): string {
    if (typeof response?.output_text === "string" && response.output_text.trim()) {
      return response.output_text.trim();
    }

    const chunks: string[] = [];
    for (const item of response?.output ?? []) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string" && part.text.trim()) {
            chunks.push(part.text.trim());
          }
        }
      } else if (typeof item?.text === "string" && item.text.trim()) {
        chunks.push(item.text.trim());
      }
    }
    return chunks.join("\n").trim();
  }

  private openAiTools(includeBuiltIns: boolean): Array<Record<string, unknown>> {
    const tools = this.tools.openAiTools();
    if (includeBuiltIns && this.config.openaiEnableWebSearch) {
      tools.push({ type: "web_search_preview" });
    }
    return tools;
  }

  private reasoningFor(mode?: "voice" | "deep"): Record<string, unknown> | undefined {
    const effort = mode === "deep" ? this.config.openaiDeepReasoningEffort : this.config.openaiVoiceReasoningEffort;
    return effort ? { effort } : undefined;
  }

  private canRetryWithoutPowerOptions(error: unknown): boolean {
    const message = String((error as { message?: unknown })?.message ?? error);
    return /web_search|reasoning|unsupported|unknown parameter|invalid.*tool|invalid.*reasoning/i.test(message);
  }

  private async createResponse(
    base: Record<string, unknown>,
    mode: "voice" | "deep" | undefined,
    timeoutMs: number,
    label: string
  ): Promise<any> {
    const primary: Record<string, unknown> = {
      ...base,
      tools: this.openAiTools(true)
    };
    const reasoning = this.reasoningFor(mode);
    if (reasoning) primary.reasoning = reasoning;

    try {
      return await this.withTimeout(this.client!.responses.create(primary as never) as Promise<any>, timeoutMs, label);
    } catch (error) {
      if (!this.canRetryWithoutPowerOptions(error)) throw error;
      this.logger.warn({ error }, "openai power options rejected; retrying without built-in web/reasoning");
      const fallback: Record<string, unknown> = {
        ...base,
        tools: this.openAiTools(false)
      };
      return this.withTimeout(this.client!.responses.create(fallback as never) as Promise<any>, timeoutMs, `${label}_fallback`);
    }
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
    let memories: Array<{ key: string; value: string }> = [];
    try {
      memories = await this.withTimeout(this.memory.recall(input.userId), 2500, "memory_recall");
    } catch (error) {
      this.logger.warn({ error }, "memory recall skipped");
    }

    const instructions = [
      "You are ESPClaw, a private desktop assistant connected to an ESP32-S3-BOX-3B.",
      "The device is an ESP32-S3-BOX-3B with touch display, buttons, microphones, speaker hardware, IMU, and environmental sensors. Do not assume a rotary knob, IR receiver, or ESP32-C3-LCDkit hardware.",
      "You are a fast desktop operations assistant. Act directly when the user's intent is clear.",
      "Keep voice replies short, natural, and useful. Prefer one or two sentences unless the user asks for detail.",
      "Never reveal backend secrets, API keys, tokens, refresh tokens, or internal credentials.",
      "Use Gmail, Calendar, Drive, Contacts, Telegram, device display, and web search tools aggressively when they help.",
      "Read-only actions, searches, summaries, and drafts should proceed without extra confirmation.",
      "Sending emails, deleting data, changing access, purchases, or destructive account actions must go through the permission flow and may return pending approval.",
      memories.length ? `Relevant memory: ${memories.map((m) => `${m.key}=${m.value}`).join("; ")}` : ""
    ].filter(Boolean).join("\n");

    const context: ToolExecutionContext = {
      userId: input.userId,
      deviceId: input.deviceId
    };

    try {
      let response = await this.createResponse({
        model,
        instructions,
        input: input.text,
        tool_choice: "auto"
      }, input.mode, input.mode === "deep" ? 60000 : 25000, "openai_response");

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
          const result = await this.withTimeout(this.tools.run(call.name, args, context), 20000, `tool_${call.name}`);
          toolOutputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result)
          });
        }

        response = await this.createResponse({
          model,
          instructions,
          previous_response_id: response.id,
          input: toolOutputs
        }, input.mode, input.mode === "deep" ? 60000 : 25000, "openai_tool_followup");
      }

      const text = this.extractText(response) || "Done.";
      this.logger.info({ model, chars: text.length }, "openai response completed");
      return text;
    } catch (error) {
      this.logger.error({ error, model }, "openai response failed");
      return "Backend LLM call failed. Check the Render logs, then try again.";
    }
  }
}
