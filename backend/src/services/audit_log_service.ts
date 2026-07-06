import type { FastifyBaseLogger } from "fastify";
import type { ToolRiskLevel } from "../types/assistant.js";
import type { DbClient } from "../db/client.js";
import { actionLogs } from "../db/schema.js";

export type AuditStatus = "allowed" | "pending_approval" | "approved" | "denied" | "failed" | "completed";

export class AuditLogService {
  constructor(private readonly db: DbClient | undefined, private readonly logger: FastifyBaseLogger) {}

  async record(input: {
    userId?: string;
    deviceId?: string;
    action: string;
    risk: ToolRiskLevel;
    status: AuditStatus;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    this.logger.info({ action: input.action, risk: input.risk, status: input.status }, "assistant action audit");
    if (!this.db) return;
    try {
      await this.db.insert(actionLogs).values({
        userId: input.userId,
        deviceId: input.deviceId,
        action: input.action,
        risk: input.risk,
        status: input.status,
        metadata: input.metadata ?? {}
      });
    } catch (error) {
      this.logger.warn({ error }, "failed to write audit log");
    }
  }
}

