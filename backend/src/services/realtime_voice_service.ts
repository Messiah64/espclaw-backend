import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { ToolExecutionContext } from "../types/assistant.js";
import type { BackendToDeviceEvent } from "../types/protocol.js";
import { ToolRegistry } from "../tools/tool_registry.js";
import { AuditLogService } from "./audit_log_service.js";

type DeviceSender = (event: BackendToDeviceEvent) => void;

type RealtimeEvent = {
  type?: string;
  [key: string]: any;
};

type RealtimeSessionOptions = {
  userId: string;
  deviceId: string;
  sampleRate: number;
  autoRespond: boolean;
  send: DeviceSender;
  onFinalTranscript?: (text: string) => void;
};

function safeJsonParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hashSafetyId(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `espclaw-${hash.toString(16).padStart(8, "0")}`;
}

const DEVICE_AUDIO_B64_CHARS = 2400;
const TEXT_MODALITIES = ["text"];

export class RealtimeVoiceSession {
  private readonly ws: WebSocket;
  private readonly context: ToolExecutionContext;
  private closeAfterResponse = false;
  private closed = false;
  private startedAt = Date.now();
  private assistantText = "";
  private assistantTranscript = "";
  private userTranscript = "";
  private openPromise: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly tools: ToolRegistry,
    private readonly audit: AuditLogService,
    private readonly logger: FastifyBaseLogger,
    private readonly options: RealtimeSessionOptions
  ) {
    this.context = { userId: options.userId, deviceId: options.deviceId };
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openaiRealtimeModel)}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "OpenAI-Safety-Identifier": hashSafetyId(options.userId)
      }
    });

    this.openPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("realtime_open_timeout")), 10_000);
      this.ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data.toString()).catch((error) => {
        this.logger.error({ error, deviceId: options.deviceId }, "realtime event handler failed");
      });
    });
    this.ws.on("error", (error) => {
      this.logger.error({ error, deviceId: options.deviceId }, "realtime websocket error");
      options.send({ type: "error", code: "openai_realtime_error", message: "OpenAI Realtime socket error." });
    });
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      options.send({ type: "state_update", state: { openai_realtime: "closed", realtime_close_code: code } });
      this.logger.info({ code, reason: reason.toString(), deviceId: options.deviceId }, "realtime websocket closed");
    });
  }

  async start(): Promise<void> {
    await this.openPromise;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: this.config.openaiRealtimeModel,
        output_modalities: TEXT_MODALITIES,
        instructions: "Transcribe the microphone accurately. Do not answer the user; the text agent handles responses.",
        reasoning: this.config.openaiRealtimeReasoningEffort
          ? { effort: this.config.openaiRealtimeReasoningEffort }
          : undefined,
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: this.options.sampleRate
            },
            transcription: {
              model: this.config.openaiRealtimeTranscriptModel,
              language: "en",
              delay: "low"
            },
            turn_detection: this.options.autoRespond
              ? {
                  type: "semantic_vad",
                  create_response: false,
                  interrupt_response: false
                }
              : null
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: this.config.openaiRealtimeVoice
          }
        },
        tools: [],
        tool_choice: "none",
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: {
            post_instructions: 8000
          }
        }
      }
    });
    this.options.send({
      type: "state_update",
      state: {
        openai_realtime: "connected",
        realtime_model: this.config.openaiRealtimeModel,
        realtime_output_audio: false,
        realtime_sample_rate: this.options.sampleRate
      }
    });
  }

  async sendAudio(data: Buffer): Promise<void> {
    if (this.closed || data.length === 0) return;
    await this.openPromise;
    this.send({
      type: "input_audio_buffer.append",
      audio: data.toString("base64")
    });
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.closed) return;
    await this.openPromise;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: trimmed }]
      }
    });
    this.options.onFinalTranscript?.(trimmed);
  }

  async stopInput(): Promise<void> {
    if (this.closed) return;
    await this.openPromise;
    this.closeAfterResponse = true;
    if (!this.options.autoRespond) {
      this.send({ type: "input_audio_buffer.commit" });
      return;
    }
    setTimeout(() => this.finish(), 750);
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // Ignore close races with the underlying socket.
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private outputModalities(): string[] {
    return TEXT_MODALITIES;
  }

  private async handleMessage(raw: string): Promise<void> {
    const event = safeJsonParse(raw) as RealtimeEvent;
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.logger.debug({ type: event.type, deviceId: this.options.deviceId }, "realtime session event");
        break;
      case "input_audio_buffer.speech_started":
        this.startedAt = Date.now();
        this.userTranscript = "";
        this.options.send({ type: "assistant_thinking", active: false });
        this.options.send({ type: "state_update", state: { user_speaking: true } });
        break;
      case "input_audio_buffer.speech_stopped":
        this.options.send({ type: "state_update", state: { user_speaking: false } });
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string" && event.delta) {
          this.userTranscript += event.delta;
          this.options.send({ type: "transcript_interim", text: this.userTranscript.trim() });
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.userTranscript = event.transcript.trim();
          this.options.onFinalTranscript?.(event.transcript.trim());
          this.options.send({
            type: "transcript_final",
            text: event.transcript.trim(),
            latency_ms: Date.now() - this.startedAt,
            speech_final: true
          });
        }
        break;
      case "response.created":
        this.startedAt = Date.now();
        this.assistantText = "";
        this.assistantTranscript = "";
        this.options.send({ type: "assistant_thinking", active: true });
        break;
      case "response.output_text.delta":
      case "response.text.delta":
        if (typeof event.delta === "string") {
          this.assistantText += event.delta;
          this.options.send({ type: "response_text", text: this.assistantText.trim() });
        }
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (typeof event.delta === "string") {
          this.assistantTranscript += event.delta;
          this.options.send({ type: "response_text", text: this.assistantTranscript.trim() });
        }
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (this.config.openaiRealtimeOutputAudio && typeof event.delta === "string") {
          this.sendAudioToDevice(event.delta);
        }
        break;
      case "response.output_text.done":
      case "response.output_audio_transcript.done":
        if (typeof event.text === "string" && event.text.trim()) {
          this.options.send({ type: "response_text", text: event.text.trim() });
        } else if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.options.send({ type: "response_text", text: event.transcript.trim() });
        }
        break;
      case "response.done":
        await this.handleResponseDone(event);
        break;
      case "error":
      case "invalid_request_error":
        this.handleRealtimeError(event);
        break;
      default:
        if (typeof event.type === "string" && event.type.includes("rate_limits")) {
          this.options.send({ type: "state_update", state: { realtime_rate_limits: "updated" } });
        }
        break;
    }
  }

  private async handleResponseDone(event: RealtimeEvent): Promise<void> {
    const output = Array.isArray(event.response?.output) ? event.response.output : [];
    const calls = output.filter((item: any) => item?.type === "function_call" && item.name && item.call_id);
    if (calls.length) {
      await this.runToolCalls(calls);
      return;
    }

    const text = this.extractFinalText(output);
    if (text) this.options.send({ type: "response_text", text });
    if (this.config.openaiRealtimeOutputAudio) this.options.send({ type: "tts_audio_end" });
    this.options.send({ type: "assistant_thinking", active: false });
    this.logger.info({
      model: this.config.openaiRealtimeModel,
      deviceId: this.options.deviceId,
      usage: event.response?.usage
    }, "realtime response completed");
    if (this.closeAfterResponse) setTimeout(() => this.finish(), 500);
  }

  private extractFinalText(output: any[]): string {
    const chunks: string[] = [];
    for (const item of output) {
      if (!Array.isArray(item?.content)) continue;
      for (const part of item.content) {
        if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text.trim());
        if (typeof part?.transcript === "string" && part.transcript.trim()) chunks.push(part.transcript.trim());
      }
    }
    return chunks.join("\n").trim();
  }

  private sendAudioToDevice(audioB64: string): void {
    for (let offset = 0; offset < audioB64.length; offset += DEVICE_AUDIO_B64_CHARS) {
      let end = Math.min(offset + DEVICE_AUDIO_B64_CHARS, audioB64.length);
      end -= (end - offset) % 4;
      if (end <= offset) end = audioB64.length;
      this.options.send({
        type: "tts_audio_chunk",
        audio_b64: audioB64.slice(offset, end),
        mime_type: "audio/pcm;rate=24000"
      });
    }
  }

  private async runToolCalls(calls: any[]): Promise<void> {
    for (const call of calls) {
      const args = safeJsonParse(String(call.arguments ?? "{}"));
      this.options.send({ type: "tool_call_started", tool_call_id: call.call_id, tool_name: call.name });
      await this.audit.record({
        userId: this.options.userId,
        deviceId: this.options.deviceId,
        action: `tool.${call.name}`,
        risk: "read_only",
        status: "allowed",
        metadata: { callId: call.call_id, realtime: true }
      });
      try {
        const result = await this.tools.run(call.name, args, this.context);
        this.options.send({
          type: "tool_call_finished",
          tool_call_id: call.call_id,
          tool_name: call.name,
          ok: result.ok,
          summary: result.text
        });
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result)
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Tool execution failed.";
        this.options.send({
          type: "tool_call_finished",
          tool_call_id: call.call_id,
          tool_name: call.name,
          ok: false,
          summary: message
        });
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ ok: false, text: message })
          }
        });
      }
    }
    this.send({
      type: "response.create",
      response: {
        output_modalities: this.outputModalities()
      }
    });
  }

  private handleRealtimeError(event: RealtimeEvent): void {
    const error = event.error ?? event;
    const message = String(error.message ?? "OpenAI Realtime request failed.");
    this.logger.error({ event, deviceId: this.options.deviceId }, "openai realtime returned error");
    this.options.send({ type: "error", code: String(error.code ?? "openai_realtime_error"), message });
    this.options.send({ type: "assistant_thinking", active: false });
  }
}

export class RealtimeVoiceService {
  constructor(
    private readonly config: AppConfig,
    private readonly tools: ToolRegistry,
    private readonly audit: AuditLogService,
    private readonly logger: FastifyBaseLogger
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.openaiApiKey && this.config.openaiRealtimeEnabled);
  }

  createSession(options: RealtimeSessionOptions): RealtimeVoiceSession | undefined {
    if (!this.isConfigured()) {
      options.send({
        type: "error",
        code: "openai_realtime_not_configured",
        message: "OpenAI Realtime is not configured on the backend."
      });
      return undefined;
    }
    return new RealtimeVoiceSession(this.config, this.tools, this.audit, this.logger, options);
  }
}
