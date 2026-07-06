import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const server = await buildServer(config);

try {
  await server.listen({ host: "0.0.0.0", port: config.port });
  server.log.info({ port: config.port }, "ESPClaw backend listening");
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

