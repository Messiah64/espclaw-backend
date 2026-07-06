import type { FastifyBaseLogger } from "fastify";
import { google } from "googleapis";
import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import { oauthAccounts, oauthTokens } from "../db/schema.js";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/contacts.readonly"
];

export class GoogleOAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: DbClient | undefined,
    private readonly logger: FastifyBaseLogger
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.googleClientId && this.config.googleClientSecret);
  }

  client() {
    return new google.auth.OAuth2(
      this.config.googleClientId,
      this.config.googleClientSecret,
      this.config.googleRedirectUri
    );
  }

  startUrl(state: string): string {
    if (!this.isConfigured()) throw new Error("google_oauth_not_configured");
    return this.client().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state
    });
  }

  async handleCallback(code: string): Promise<{ email?: string; providerAccountId?: string }> {
    if (!this.isConfigured()) throw new Error("google_oauth_not_configured");
    const client = this.client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email ?? undefined;
    const providerAccountId = profile.data.id ?? undefined;

    if (this.db) {
      try {
        const accountRows = await this.db
          .insert(oauthAccounts)
          .values({ provider: "google", providerAccountId, email })
          .returning();
        const oauthAccountId = accountRows[0]?.id;
        if (oauthAccountId) {
          await this.db.insert(oauthTokens).values({
            oauthAccountId,
            accessTokenCiphertext: tokens.access_token ?? undefined,
            refreshTokenCiphertext: tokens.refresh_token ?? undefined,
            scope: tokens.scope ?? undefined,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined
          });
        }
      } catch (error) {
        this.logger.warn({ error }, "failed to persist google oauth tokens");
      }
    }

    return { email, providerAccountId };
  }

  async getAuthorizedClient() {
    const client = this.client();
    return client;
  }
}

