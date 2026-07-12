import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { DbClient } from "../db/client.js";
import { agentMonitors } from "../db/schema.js";
import type { BackendToDeviceEvent } from "../types/protocol.js";
import type { ToolExecutionResult } from "../types/assistant.js";
import type { GmailService } from "./gmail_service.js";
import type { TelegramService } from "./telegram_service.js";

type DeviceBroadcast = (event: BackendToDeviceEvent) => void;

export class MonitorService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbClient | undefined,
    private readonly gmail: GmailService,
    private readonly telegram: TelegramService,
    private readonly broadcast: DeviceBroadcast,
    private readonly logger: FastifyBaseLogger
  ) {}

  start(): void {
    if (this.timer || !this.db) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async createGmail(ownerKey: string, query: string, label: string): Promise<ToolExecutionResult> {
    if (!this.db) return { ok: false, text: "Notification tracking requires Postgres." };
    const rows = await this.db.insert(agentMonitors).values({
      ownerKey,
      kind: "gmail",
      query: query.slice(0, 1000),
      label: label.slice(0, 160)
    }).returning({ id: agentMonitors.id });
    return { ok: true, text: `Watching Gmail for ${label || query}.`, data: { monitorId: rows[0]?.id } };
  }

  async list(ownerKey: string): Promise<ToolExecutionResult> {
    if (!this.db) return { ok: false, text: "Notification tracking requires Postgres." };
    const rows = await this.db.select({
      id: agentMonitors.id,
      kind: agentMonitors.kind,
      query: agentMonitors.query,
      label: agentMonitors.label,
      enabled: agentMonitors.enabled
    }).from(agentMonitors).where(eq(agentMonitors.ownerKey, ownerKey)).limit(50);
    return { ok: true, text: `${rows.filter((row) => row.enabled).length} notification watches are active.`, data: rows };
  }

  async disable(ownerKey: string, monitorId: string): Promise<ToolExecutionResult> {
    if (!this.db) return { ok: false, text: "Notification tracking requires Postgres." };
    const rows = await this.db.update(agentMonitors)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(agentMonitors.ownerKey, ownerKey), eq(agentMonitors.id, monitorId)))
      .returning({ id: agentMonitors.id });
    return { ok: rows.length > 0, text: rows.length ? "Notification watch stopped." : "Notification watch not found." };
  }

  private fingerprint(data: unknown): string {
    return createHash("sha256").update(JSON.stringify(data ?? [])).digest("hex");
  }

  private async tick(): Promise<void> {
    if (!this.db) return;
    const monitors = await this.db.select().from(agentMonitors).where(eq(agentMonitors.enabled, true)).limit(100);
    for (const monitor of monitors) {
      try {
        if (monitor.kind !== "gmail") continue;
        const result = await this.gmail.search(monitor.ownerKey, monitor.query);
        if (!result.ok) continue;
        const fingerprint = this.fingerprint(result.data);
        if (!monitor.lastFingerprint) {
          await this.db.update(agentMonitors).set({ lastFingerprint: fingerprint, updatedAt: new Date() })
            .where(eq(agentMonitors.id, monitor.id));
          continue;
        }
        if (fingerprint === monitor.lastFingerprint) continue;
        await this.db.update(agentMonitors).set({ lastFingerprint: fingerprint, updatedAt: new Date() })
          .where(eq(agentMonitors.id, monitor.id));
        const text = `Update detected: ${monitor.label || monitor.query}`;
        await this.telegram.sendOwnerMessage(text);
        this.broadcast({ type: "response_text", text });
      } catch (error) {
        this.logger.warn({ error, monitorId: monitor.id }, "notification monitor check failed");
      }
    }
  }
}
