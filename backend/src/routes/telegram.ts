import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { PermissionService } from "../services/permission_service.js";
import type { TelegramService, TelegramUpdate } from "../services/telegram_service.js";

function helpText(baseUrl: string): string {
  return [
    "ESPClaw Telegram control",
    "",
    "/status - backend status",
    "/connect_google - start Google OAuth",
    "/revoke_google - revoke Google connection placeholder",
    "/approve <id> - approve sensitive action",
    "/deny <id> - deny sensitive action",
    "/mute /unmute - control voice routing placeholder",
    "/always_stream_on /always_stream_off - streaming mode placeholder",
    "/logs - recent audit log summary",
    "/help - show this menu",
    "",
    `Health: ${baseUrl.replace(/\/$/, "")}/healthz`
  ].join("\n");
}

export async function registerTelegramRoutes(
  server: FastifyInstance,
  config: AppConfig,
  telegram: TelegramService,
  permission: PermissionService
) {
  server.post<{ Params: { secret: string }; Body: TelegramUpdate }>("/telegram/webhook/:secret", async (request, reply) => {
    if (!telegram.verifyWebhookSecret(request.params.secret)) {
      reply.status(401).send({ ok: false, error: "bad_webhook_secret" });
      return;
    }

    const message = request.body.message;
    const callback = request.body.callback_query;
    const fromId = message?.from?.id ?? callback?.from.id;
    const chatId = message?.chat.id ?? callback?.message?.chat.id;

    if (!telegram.isOwner(fromId)) {
      if (chatId) await telegram.sendMessage(chatId, "Not authorized.");
      reply.send({ ok: true, ignored: true });
      return;
    }

    const text = message?.text?.trim() ?? callback?.data?.trim() ?? "";
    const [command, arg] = text.split(/\s+/, 2);
    const targetChat = chatId ?? config.ownerTelegramUserId!;

    switch (command) {
      case "/start":
      case "/help":
        await telegram.sendMessage(targetChat, helpText(config.publicBaseUrl));
        break;
      case "/status":
        await telegram.sendMessage(targetChat, await permission.status());
        break;
      case "/connect_google":
        await telegram.sendMessage(targetChat, `${config.publicBaseUrl.replace(/\/$/, "")}/oauth/google/start`);
        break;
      case "/revoke_google":
        await telegram.sendMessage(targetChat, "Google revoke endpoint is reserved; remove the OAuth token row from Postgres for now.");
        break;
      case "/approve":
        await telegram.sendMessage(targetChat, arg && await permission.decide(arg, true) ? `Approved ${arg}.` : "Approval ID not found.");
        break;
      case "/deny":
        await telegram.sendMessage(targetChat, arg && await permission.decide(arg, false) ? `Denied ${arg}.` : "Approval ID not found.");
        break;
      case "/mute":
        await telegram.sendMessage(targetChat, "Muted.");
        break;
      case "/unmute":
        await telegram.sendMessage(targetChat, "Unmuted.");
        break;
      case "/always_stream_on":
        await telegram.sendMessage(targetChat, "Always-stream mode requested.");
        break;
      case "/always_stream_off":
        await telegram.sendMessage(targetChat, "Always-stream mode disabled.");
        break;
      case "/logs":
        await telegram.sendMessage(targetChat, "Audit logs are stored in Postgres table action_logs when DATABASE_URL is configured.");
        break;
      default:
        await telegram.sendMessage(targetChat, "Unknown command. Send /help.");
        break;
    }

    reply.send({ ok: true });
  });
}

