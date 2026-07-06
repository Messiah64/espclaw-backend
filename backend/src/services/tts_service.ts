import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";

export class TtsService {
  constructor(private readonly config: AppConfig, private readonly logger: FastifyBaseLogger) {}

  async synthesizeShortReply(_text: string): Promise<{ mimeType: string; chunks: Buffer[] }> {
    this.logger.debug({ model: this.config.openaiFastModel }, "tts requested");
    return { mimeType: "audio/mpeg", chunks: [] };
  }
}

