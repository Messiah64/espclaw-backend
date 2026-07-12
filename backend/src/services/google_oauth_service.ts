import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
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

  private encryptionKey(): Buffer {
    return createHash("sha256").update(this.config.jwtSecret ?? "espclaw-development-only").digest();
  }

  private seal(value?: string | null): string | undefined {
    if (!value) return undefined;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  private unseal(value?: string | null): string | undefined {
    if (!value) return undefined;
    if (!value.startsWith("enc:v1:")) return value;
    const [, , ivB64, tagB64, dataB64] = value.split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("invalid_oauth_token_ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  }

  private async persistTokens(oauthAccountId: string, tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    scope?: string | null;
    expiry_date?: number | null;
  }): Promise<void> {
    if (!this.db) return;
    const existing = await this.db.select().from(oauthTokens)
      .where(eq(oauthTokens.oauthAccountId, oauthAccountId))
      .orderBy(desc(oauthTokens.updatedAt))
      .limit(1);
    const values = {
      accessTokenCiphertext: this.seal(tokens.access_token) ?? existing[0]?.accessTokenCiphertext,
      refreshTokenCiphertext: this.seal(tokens.refresh_token) ?? existing[0]?.refreshTokenCiphertext,
      scope: tokens.scope ?? existing[0]?.scope,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : existing[0]?.expiresAt,
      updatedAt: new Date()
    };
    if (existing[0]) {
      await this.db.update(oauthTokens).set(values).where(eq(oauthTokens.id, existing[0].id));
    } else {
      await this.db.insert(oauthTokens).values({ oauthAccountId, ...values });
    }
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
        const current = providerAccountId
          ? await this.db.select().from(oauthAccounts).where(eq(oauthAccounts.providerAccountId, providerAccountId)).limit(1)
          : [];
        const accountRows = current.length ? current : await this.db
          .insert(oauthAccounts)
          .values({ provider: "google", providerAccountId, email })
          .returning();
        const oauthAccountId = accountRows[0]?.id;
        if (oauthAccountId) {
          await this.persistTokens(oauthAccountId, tokens);
        }
      } catch (error) {
        this.logger.warn({ error }, "failed to persist google oauth tokens");
      }
    }

    return { email, providerAccountId };
  }

  async getAuthorizedClient() {
    if (!this.isConfigured()) throw new Error("google_oauth_not_configured");
    if (!this.db) throw new Error("google_oauth_requires_database");
    const rows = await this.db.select({
      accountId: oauthAccounts.id,
      accessToken: oauthTokens.accessTokenCiphertext,
      refreshToken: oauthTokens.refreshTokenCiphertext,
      scope: oauthTokens.scope,
      expiresAt: oauthTokens.expiresAt
    }).from(oauthAccounts)
      .innerJoin(oauthTokens, eq(oauthTokens.oauthAccountId, oauthAccounts.id))
      .where(eq(oauthAccounts.provider, "google"))
      .orderBy(desc(oauthTokens.updatedAt))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("google_account_not_connected");
    const client = this.client();
    client.setCredentials({
      access_token: this.unseal(row.accessToken),
      refresh_token: this.unseal(row.refreshToken),
      scope: row.scope ?? undefined,
      expiry_date: row.expiresAt?.getTime()
    });
    client.on("tokens", (tokens) => {
      void this.persistTokens(row.accountId, tokens).catch((error) => {
        this.logger.warn({ error }, "failed to persist refreshed google token");
      });
    });
    return client;
  }
}
