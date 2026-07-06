import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GoogleOAuthService } from "../services/google_oauth_service.js";

export async function registerGoogleOAuthRoutes(server: FastifyInstance, googleOAuth: GoogleOAuthService) {
  server.get("/oauth/google/start", async (_request, reply) => {
    const state = randomBytes(16).toString("hex");
    const url = googleOAuth.startUrl(state);
    reply.redirect(url);
  });

  server.get<{ Querystring: { code?: string; error?: string } }>("/oauth/google/callback", async (request, reply) => {
    if (request.query.error) {
      reply.status(400).send({ ok: false, error: request.query.error });
      return;
    }
    if (!request.query.code) {
      reply.status(400).send({ ok: false, error: "missing_code" });
      return;
    }
    const profile = await googleOAuth.handleCallback(request.query.code);
    reply.type("text/html").send(`
      <html>
        <body style="font-family: system-ui; padding: 32px;">
          <h1>Google connected</h1>
          <p>ESPClaw can now use approved Google tools for ${profile.email ?? "this account"}.</p>
          <p>You can close this tab.</p>
        </body>
      </html>
    `);
  });
}

