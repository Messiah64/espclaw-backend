import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import { devices } from "../db/schema.js";
import { AuditLogService } from "./audit_log_service.js";

const memoryDevices = new Map<string, string>();

function tokenHash(token: string, jwtSecret?: string): string {
  return createHash("sha256").update(`${jwtSecret ?? "dev"}:${token}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class DeviceAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: DbClient | undefined,
    private readonly audit: AuditLogService,
    private readonly logger: FastifyBaseLogger
  ) {}

  async pair(pairingSecret?: string, label?: string): Promise<{ deviceId: string; deviceToken: string }> {
    if (this.config.devicePairingSecret && pairingSecret !== this.config.devicePairingSecret) {
      throw new Error("invalid_pairing_secret");
    }
    if (this.config.nodeEnv === "production" && !this.config.devicePairingSecret) {
      throw new Error("pairing_disabled_missing_secret");
    }

    const deviceId = `espclaw_${randomUUID()}`;
    const deviceToken = randomBytes(32).toString("base64url");
    const hash = tokenHash(deviceToken, this.config.jwtSecret);

    if (this.db) {
      await this.db.insert(devices).values({ deviceId, tokenHash: hash, label });
    } else {
      memoryDevices.set(deviceId, hash);
    }

    await this.audit.record({ action: "device.pair", risk: "low_risk_write", status: "completed", metadata: { deviceId } });
    return { deviceId, deviceToken };
  }

  async verify(deviceId: string, deviceToken: string): Promise<boolean> {
    const hash = tokenHash(deviceToken, this.config.jwtSecret);
    if (this.db) {
      const rows = await this.db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
      const row = rows[0];
      if (!row) return false;
      await this.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, row.id));
      return safeEqual(row.tokenHash, hash);
    }
    const expected = memoryDevices.get(deviceId);
    if (expected) return safeEqual(expected, hash);
    const devAllowed = this.config.nodeEnv !== "production" && deviceId.length > 0 && deviceToken.length > 0;
    if (devAllowed) this.logger.warn({ deviceId }, "accepting unpaired device in development");
    return devAllowed;
  }
}

