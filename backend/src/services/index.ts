import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { calendarTools } from "../tools/calendar_tools.js";
import { contactsTools } from "../tools/contacts_tools.js";
import { deviceTools, type DevicePush } from "../tools/device_tools.js";
import { driveTools } from "../tools/drive_tools.js";
import { gmailTools } from "../tools/gmail_tools.js";
import { telegramTools } from "../tools/telegram_tools.js";
import { ToolRegistry } from "../tools/tool_registry.js";
import { AuditLogService } from "./audit_log_service.js";
import { CalendarService } from "./calendar_service.js";
import { ContactsService } from "./contacts_service.js";
import { DeepgramService } from "./deepgram_service.js";
import { DeviceAuthService } from "./device_auth_service.js";
import { DriveService } from "./drive_service.js";
import { GmailService } from "./gmail_service.js";
import { GoogleOAuthService } from "./google_oauth_service.js";
import { MemoryService } from "./memory_service.js";
import { OpenAIService } from "./openai_service.js";
import { PermissionService } from "./permission_service.js";
import { RealtimeVoiceService } from "./realtime_voice_service.js";
import { TelegramService } from "./telegram_service.js";
import { TtsService } from "./tts_service.js";

const devicePushers = new Map<string, DevicePush>();

export function createServices(config: AppConfig, logger: FastifyBaseLogger) {
  const { db, pool } = createDb(config.databaseUrl);
  const auditLog = new AuditLogService(db, logger);
  const memory = new MemoryService(db);
  const telegram = new TelegramService(config, logger);
  const permission = new PermissionService(config, db, auditLog, telegram);
  const googleOAuth = new GoogleOAuthService(config, db, logger);
  const gmail = new GmailService(googleOAuth, permission);
  const calendar = new CalendarService(googleOAuth, permission);
  const drive = new DriveService(googleOAuth);
  const contacts = new ContactsService(googleOAuth);
  const deviceAuth = new DeviceAuthService(config, db, auditLog, logger);
  const deepgram = new DeepgramService(config, auditLog, logger);
  const tts = new TtsService(config, logger);

  const pushToDevice: DevicePush = (deviceId, event) => {
    const push = devicePushers.get(deviceId);
    if (!push) return false;
    return push(deviceId, event);
  };

  const tools = new ToolRegistry();
  [
    ...gmailTools(gmail),
    ...calendarTools(calendar),
    ...driveTools(drive),
    ...contactsTools(contacts),
    ...telegramTools(telegram),
    ...deviceTools(pushToDevice)
  ].forEach((tool) => tools.register(tool));

  const openai = new OpenAIService(config, tools, memory, auditLog, logger);
  const realtimeVoice = new RealtimeVoiceService(config, tools, auditLog, logger);

  return {
    pool,
    auditLog,
    memory,
    telegram,
    permission,
    googleOAuth,
    gmail,
    calendar,
    drive,
    contacts,
    deviceAuth,
    deepgram,
    tts,
    tools,
    openai,
    realtimeVoice,
    registerDevicePusher(deviceId: string, push: DevicePush) {
      devicePushers.set(deviceId, push);
    },
    unregisterDevicePusher(deviceId: string) {
      devicePushers.delete(deviceId);
    }
  };
}
