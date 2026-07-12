import { google } from "googleapis";
import { GoogleOAuthService } from "./google_oauth_service.js";
import { PermissionService } from "./permission_service.js";
import type { ToolExecutionResult } from "../types/assistant.js";

export class CalendarService {
  constructor(private readonly googleOAuth: GoogleOAuthService, private readonly permission: PermissionService) {}

  async listUpcoming(userId: string): Promise<ToolExecutionResult> {
    const auth = await this.googleOAuth.getAuthorizedClient();
    const calendar = google.calendar({ version: "v3", auth });
    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime"
    });
    return { ok: true, text: `Found ${result.data.items?.length ?? 0} upcoming events.`, data: result.data.items ?? [] };
  }

  async createEvent(userId: string, summary: string, start: string, end: string, confidence: "low" | "medium" | "high"): Promise<ToolExecutionResult> {
    const authz = await this.permission.authorize({
      userId,
      action: "calendar.create",
      risk: "sensitive_write",
      payload: { summary, start, end },
      confidence
    });
    if (!authz.allowed) {
      return { ok: false, text: "Calendar event creation is pending Telegram approval.", pendingApprovalId: authz.approvalId };
    }
    return this.executeApprovedCreate({ summary, start, end });
  }

  async executeApprovedCreate(payload: unknown): Promise<ToolExecutionResult> {
    const data = payload as { summary?: unknown; start?: unknown; end?: unknown };
    const summary = typeof data?.summary === "string" ? data.summary : "";
    const start = typeof data?.start === "string" ? data.start : "";
    const end = typeof data?.end === "string" ? data.end : "";
    if (!summary || !start || !end) return { ok: false, text: "Approved calendar payload is incomplete." };
    const auth = await this.googleOAuth.getAuthorizedClient();
    const calendar = google.calendar({ version: "v3", auth });
    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: { summary, start: { dateTime: start }, end: { dateTime: end } }
    });
    return { ok: true, text: `Calendar event created: ${summary}`, data: { eventId: result.data.id, htmlLink: result.data.htmlLink } };
  }
}
