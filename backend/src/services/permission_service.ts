import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import { pendingApprovals } from "../db/schema.js";
import type { ToolRiskLevel } from "../types/assistant.js";
import { AuditLogService } from "./audit_log_service.js";
import { TelegramService } from "./telegram_service.js";

const memoryApprovals = new Map<string, { action: string; risk: ToolRiskLevel; payload: unknown; approved?: boolean }>();

export class PermissionService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: DbClient | undefined,
    private readonly audit: AuditLogService,
    private readonly telegram: TelegramService
  ) {}

  async authorize(input: {
    userId: string;
    action: string;
    risk: ToolRiskLevel;
    payload?: unknown;
    confidence?: "low" | "medium" | "high";
  }): Promise<{ allowed: boolean; approvalId?: string; reason?: string }> {
    if (input.risk === "read_only" || input.risk === "low_risk_write") {
      await this.audit.record({ userId: input.userId, action: input.action, risk: input.risk, status: "allowed" });
      return { allowed: true };
    }

    if (input.action.startsWith("calendar.create") && input.confidence === "high") {
      await this.audit.record({ userId: input.userId, action: input.action, risk: input.risk, status: "allowed" });
      return { allowed: true };
    }

    const approvalId = await this.createApproval(input.userId, input.action, input.risk, input.payload ?? {});
    await this.audit.record({
      userId: input.userId,
      action: input.action,
      risk: input.risk,
      status: "pending_approval",
      metadata: { approvalId }
    });
    await this.telegram.sendOwnerMessage(
      `Approval required\n\nID: \`${approvalId}\`\nAction: \`${input.action}\`\nRisk: \`${input.risk}\`\n\nReply /approve ${approvalId} or /deny ${approvalId}.`
    );
    return { allowed: false, approvalId, reason: "telegram_approval_required" };
  }

  async createApproval(userId: string, action: string, risk: ToolRiskLevel, payload: unknown): Promise<string> {
    const id = randomUUID();
    if (!this.db) {
      memoryApprovals.set(id, { action, risk, payload });
      return id;
    }
    await this.db.insert(pendingApprovals).values({ id, userId, action, risk, payload: payload as Record<string, unknown> });
    return id;
  }

  async decide(approvalId: string, approved: boolean): Promise<boolean> {
    if (!this.db) {
      const approval = memoryApprovals.get(approvalId);
      if (!approval) return false;
      approval.approved = approved;
      memoryApprovals.set(approvalId, approval);
      return true;
    }
    const rows = await this.db
      .update(pendingApprovals)
      .set({ approved, decidedAt: new Date() })
      .where(eq(pendingApprovals.id, approvalId))
      .returning();
    return rows.length > 0;
  }

  async status(): Promise<string> {
    return [
      "ESPClaw approvals online.",
      `Telegram: ${this.telegram.isConfigured() ? "configured" : "missing env"}`,
      `Postgres: ${this.config.databaseUrl ? "configured" : "memory fallback"}`
    ].join("\n");
  }
}

