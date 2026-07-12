import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import { pendingApprovals } from "../db/schema.js";
import type { ToolExecutionResult, ToolRiskLevel } from "../types/assistant.js";
import { AuditLogService } from "./audit_log_service.js";
import { TelegramService } from "./telegram_service.js";

type ApprovalRecord = { ownerKey: string; action: string; risk: ToolRiskLevel; payload: unknown; approved?: boolean };
type ApprovalExecutor = (payload: unknown) => Promise<ToolExecutionResult>;

const memoryApprovals = new Map<string, ApprovalRecord>();

export class PermissionService {
  private readonly executors = new Map<string, ApprovalExecutor>();
  constructor(
    private readonly config: AppConfig,
    private readonly db: DbClient | undefined,
    private readonly audit: AuditLogService,
    private readonly telegram: TelegramService
  ) {}

  registerExecutor(action: string, executor: ApprovalExecutor): void {
    this.executors.set(action, executor);
  }

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
      memoryApprovals.set(id, { ownerKey: userId, action, risk, payload });
      return id;
    }
    await this.db.insert(pendingApprovals).values({ id, ownerKey: userId, action, risk, payload: payload as Record<string, unknown> });
    return id;
  }

  async decide(approvalId: string, approved: boolean): Promise<{ found: boolean; message: string }> {
    let approval: ApprovalRecord | undefined;
    if (!this.db) {
      approval = memoryApprovals.get(approvalId);
      if (!approval) return { found: false, message: "Approval ID not found." };
      if (approval.approved !== undefined) return { found: true, message: "This approval was already decided." };
      approval.approved = approved;
      memoryApprovals.set(approvalId, approval);
    } else {
      const existing = await this.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, approvalId)).limit(1);
      if (!existing[0]) return { found: false, message: "Approval ID not found." };
      if (existing[0].decidedAt) return { found: true, message: "This approval was already decided." };
      approval = {
        ownerKey: existing[0].ownerKey,
        action: existing[0].action,
        risk: existing[0].risk as ToolRiskLevel,
        payload: existing[0].payload,
        approved
      };
      await this.db.update(pendingApprovals)
        .set({ approved, decidedAt: new Date() })
        .where(eq(pendingApprovals.id, approvalId));
    }

    if (!approved) {
      await this.audit.record({ action: approval.action, risk: approval.risk, status: "denied", metadata: { approvalId } });
      return { found: true, message: `Denied ${approval.action}.` };
    }

    const executor = this.executors.get(approval.action);
    if (!executor) {
      await this.audit.record({ action: approval.action, risk: approval.risk, status: "approved", metadata: { approvalId } });
      return { found: true, message: `Approved ${approval.action}; no executor is registered.` };
    }

    try {
      const result = await executor(approval.payload);
      await this.audit.record({
        action: approval.action,
        risk: approval.risk,
        status: result.ok ? "completed" : "failed",
        metadata: { approvalId }
      });
      return { found: true, message: result.text };
    } catch (error) {
      await this.audit.record({ action: approval.action, risk: approval.risk, status: "failed", metadata: { approvalId } });
      return { found: true, message: `Approved action failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  async status(): Promise<string> {
    return [
      "ESPClaw approvals online.",
      `Telegram: ${this.telegram.isConfigured() ? "configured" : "missing env"}`,
      `Postgres: ${this.config.databaseUrl ? "configured" : "memory fallback"}`
    ].join("\n");
  }
}
