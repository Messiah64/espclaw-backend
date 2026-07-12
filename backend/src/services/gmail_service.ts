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
    const messages = await Promise.all((result.data.messages ?? []).slice(0, 10).map(async (message) => {
      if (!message.id) return message;
      const details = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"]
      });
      const headers = Object.fromEntries((details.data.payload?.headers ?? []).map((header) => [header.name ?? "", header.value ?? ""]));
      return { id: message.id, threadId: message.threadId, snippet: details.data.snippet, headers };
    }));
    return { ok: true, text: `Found ${messages.length} Gmail messages.`, data: messages };
  }

  private rawMessage(to: string, subject: string, body: string): string {
    const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
    return Buffer.from([
      `To: ${clean(to)}`,
      `Subject: ${clean(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body
    ].join("\r\n")).toString("base64url");
  }

  async draft(userId: string, to: string, subject: string, body: string): Promise<ToolExecutionResult> {
    await this.permission.authorize({ userId, action: "gmail.draft", risk: "low_risk_write", payload: { to, subject } });
    const auth = await this.googleOAuth.getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });
    const result = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: this.rawMessage(to, subject, body) } }
    });
    return { ok: true, text: `Draft created for ${to}: ${subject}`, data: { draftId: result.data.id } };
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
    return this.executeApprovedSend({ to, subject, body });
  }

  async executeApprovedSend(payload: unknown): Promise<ToolExecutionResult> {
    const data = payload as { to?: unknown; subject?: unknown; body?: unknown };
    const to = typeof data?.to === "string" ? data.to : "";
    const subject = typeof data?.subject === "string" ? data.subject : "";
    const body = typeof data?.body === "string" ? data.body : "";
    if (!to || !subject) return { ok: false, text: "Approved email payload is incomplete." };
    const auth = await this.googleOAuth.getAuthorizedClient();
    const gmail = google.gmail({ version: "v1", auth });
    const result = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: this.rawMessage(to, subject, body) }
    });
    return { ok: true, text: `Email sent to ${to}.`, data: { messageId: result.data.id, threadId: result.data.threadId } };
  }
}
