import { google } from "googleapis";
import { PermissionService } from "./permission_service.js";
import { GoogleOAuthService } from "./google_oauth_service.js";
import type { ToolExecutionResult } from "../types/assistant.js";

export class GmailService {
  constructor(private readonly googleOAuth: GoogleOAuthService, private readonly permission: PermissionService) {}

  async search(userId: string, query: string): Promise<ToolExecutionResult> {
    const auth = await this.googleOAuth.getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });
    const result = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
    return { ok: true, text: `Found ${result.data.messages?.length ?? 0} Gmail messages.`, data: result.data.messages ?? [] };
  }

  async draft(userId: string, to: string, subject: string, body: string): Promise<ToolExecutionResult> {
    await this.permission.authorize({ userId, action: "gmail.draft", risk: "low_risk_write", payload: { to, subject } });
    return { ok: true, text: `Draft prepared for ${to}: ${subject}`, data: { to, subject, body } };
  }

  async send(userId: string, to: string, subject: string, body: string): Promise<ToolExecutionResult> {
    const auth = await this.permission.authorize({
      userId,
      action: "gmail.send",
      risk: "sensitive_write",
      payload: { to, subject, body }
    });
    if (!auth.allowed) {
      return { ok: false, text: "Email send is pending Telegram approval.", pendingApprovalId: auth.approvalId };
    }
    return { ok: true, text: `Approved to send email to ${to}.`, data: { to, subject, body } };
  }
}

