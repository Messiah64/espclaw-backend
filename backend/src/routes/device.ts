import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { AuditLogService } from "../services/audit_log_service.js";
import type { DeviceAuthService } from "../services/device_auth_service.js";

type PairBody = {
  pairing_secret?: string;
  label?: string;
};

export async function registerDeviceRoutes(
  server: FastifyInstance,
  config: AppConfig,
  deviceAuth: DeviceAuthService,
  audit: AuditLogService
) {
  server.post<{ Body: PairBody }>("/device/pair", async (request, reply) => {
    try {
      const paired = await deviceAuth.pair(request.body?.pairing_secret, request.body?.label);
      await audit.record({
        action: "device.pair_route",
        risk: "low_risk_write",
        status: "completed",
        metadata: { deviceId: paired.deviceId }
      });
      reply.send({
        backend_url: config.publicBaseUrl,
        device_id: paired.deviceId,
        device_token: paired.deviceToken
      });
    } catch (error) {
      request.log.warn({ error }, "device pairing failed");
      reply.status(401).send({ ok: false, error: "pairing_failed" });
    }
  });
}

