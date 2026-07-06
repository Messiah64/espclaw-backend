import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";

export type TelegramUpdate = {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number; first_name?: string; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
  };
};

export class TelegramService {
  constructor(private readonly config: AppConfig, private readonly logger: FastifyBaseLogger) {}

  isConfigured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.ownerTelegramUserId);
  }

  isOwner(userId?: number | string): boolean {
    return Boolean(userId && this.config.ownerTelegramUserId && String(userId) === this.config.ownerTelegramUserId);
  }

  verifyWebhookSecret(secret: string): boolean {
    return Boolean(this.config.telegramWebhookSecret && secret === this.config.telegramWebhookSecret);
  }

  async sendOwnerMessage(text: string): Promise<void> {
    if (!this.config.ownerTelegramUserId) return;
    await this.sendMessage(this.config.ownerTelegramUserId, text);
  }

  async sendMessage(chatId: string | number, text: string): Promise<void> {
    if (!this.config.telegramBotToken) {
      this.logger.warn("telegram bot token missing; dropping message");
      return;
    }
    const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    });
    if (!response.ok) {
      this.logger.warn({ status: response.status, body: await response.text() }, "telegram send failed");
    }
  }

  async setWebhook(publicBaseUrl: string): Promise<{ ok: boolean; url: string }> {
    if (!this.config.telegramBotToken || !this.config.telegramWebhookSecret) {
      return { ok: false, url: "" };
    }
    const url = `${publicBaseUrl.replace(/\/$/, "")}/telegram/webhook/${this.config.telegramWebhookSecret}`;
    const response = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    return { ok: response.ok, url };
  }
}

