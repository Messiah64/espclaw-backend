import { performance } from "node:perf_hooks";
import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import type { BackendToDeviceEvent } from "../types/protocol.js";
import { AuditLogService } from "./audit_log_service.js";

type DeviceSender = (event: BackendToDeviceEvent) => void;

export class DeepgramRealtimeSession {
  private socket?: WebSocket;
  private startedAt = performance.now();

  constructor(
    private readonly apiKey: string,
    private readonly send: DeviceSender,
    private readonly logger: FastifyBaseLogger,
    private readonly audit: AuditLogService
  ) {}

  start(sampleRate = 16_000, encoding = "linear16") {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-3");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("endpointing", "250");
    url.searchParams.set("vad_events", "true");
    url.searchParams.set("sample_rate", String(sampleRate));
    url.searchParams.set("encoding", encoding);

    this.startedAt = performance.now();
    this.socket = new WebSocket(url, ["token", this.apiKey]);
    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("error", (error) => {
      this.logger.warn({ error }, "deepgram websocket error");
      this.send({ type: "error", code: "deepgram_error", message: "Speech transcription failed." });
    });
  }

  sendAudio(chunk: Buffer) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(chunk);
    }
  }

  finish() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "CloseStream" }));
    }
    this.socket?.close();
  }

  private async handleMessage(raw: string) {
    const message = JSON.parse(raw) as {
      type?: string;
      channel?: { alternatives?: Array<{ transcript?: string }> };
      is_final?: boolean;
      speech_final?: boolean;
    };
    if (message.type === "UtteranceEnd") return;
    const text = message.channel?.alternatives?.[0]?.transcript;
    if (!text) return;
    const latency = Math.round(performance.now() - this.startedAt);
    if (message.is_final || message.speech_final) {
      await this.audit.record({ action: "deepgram.transcript_final", risk: "read_only", status: "completed", metadata: { latency } });
      this.send({ type: "transcript_final", text, latency_ms: latency, speech_final: Boolean(message.speech_final) });
    } else {
      this.send({ type: "transcript_interim", text, latency_ms: latency });
    }
  }
}

export class DeepgramService {
  constructor(
    private readonly config: AppConfig,
    private readonly audit: AuditLogService,
    private readonly logger: FastifyBaseLogger
  ) {}

  createRealtimeSession(send: DeviceSender): DeepgramRealtimeSession | undefined {
    if (!this.config.deepgramApiKey) {
      send({ type: "error", code: "deepgram_not_configured", message: "Deepgram API key is missing on backend." });
      return undefined;
    }
    return new DeepgramRealtimeSession(this.config.deepgramApiKey, send, this.logger, this.audit);
  }
}
