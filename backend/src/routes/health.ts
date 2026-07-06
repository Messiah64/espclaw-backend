import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { readiness } from "../config.js";

export async function registerHealthRoutes(server: FastifyInstance, config: AppConfig) {
  server.get("/healthz", async () => ({
    ok: true,
    service: "espclaw-backend",
    uptime_s: Math.round(process.uptime())
  }));

  server.get("/readyz", async (request, reply) => {
    const status = readiness(config);
    reply.status(status.ok ? 200 : 503).send(status);
  });
}

