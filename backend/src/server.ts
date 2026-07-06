import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { registerDeviceRoutes } from "./routes/device.js";
import { registerGoogleOAuthRoutes } from "./routes/google_oauth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { createServices } from "./services/index.js";
import { registerDeviceWebSocket } from "./ws/device_ws.js";

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug"
    }
  });

  const services = createServices(config, server.log);
  server.decorate("services", services);

  await server.register(cors, { origin: true });
  await server.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  await registerHealthRoutes(server, config);
  await registerGoogleOAuthRoutes(server, services.googleOAuth);
  await registerTelegramRoutes(server, config, services.telegram, services.permission);
  await registerDeviceRoutes(server, config, services.deviceAuth, services.auditLog);
  await registerDeviceWebSocket(server, config, services);

  server.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.status(500).send({ ok: false, error: "internal_error" });
  });

  return server;
}

declare module "fastify" {
  interface FastifyInstance {
    services: ReturnType<typeof createServices>;
  }
}

