import type { TelegramService } from "../services/telegram_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function telegramTools(telegram: TelegramService): RegisteredTool[] {
  return [
    {
      name: "telegram_notify_owner",
      description: "Send a short notification to the owner's Telegram.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      },
      handler: async (args) => {
        await telegram.sendOwnerMessage(stringArg(args, "text"));
        return { ok: true, text: "Telegram notification sent." };
      }
    }
  ];
}

