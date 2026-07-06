export type AppConfig = {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  openaiApiKey?: string;
  openaiFastModel: string;
  openaiDeepModel: string;
  deepgramApiKey?: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  ownerTelegramUserId?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  databaseUrl?: string;
  devicePairingSecret?: string;
  jwtSecret?: string;
};

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function requiredInProduction(config: AppConfig): string[] {
  const pairs: Array<[keyof AppConfig, string]> = [
    ["openaiApiKey", "OPENAI_API_KEY"],
    ["deepgramApiKey", "DEEPGRAM_API_KEY"],
    ["telegramBotToken", "TELEGRAM_BOT_TOKEN"],
    ["telegramWebhookSecret", "TELEGRAM_WEBHOOK_SECRET"],
    ["ownerTelegramUserId", "OWNER_TELEGRAM_USER_ID"],
    ["googleClientId", "GOOGLE_CLIENT_ID"],
    ["googleClientSecret", "GOOGLE_CLIENT_SECRET"],
    ["databaseUrl", "DATABASE_URL"],
    ["devicePairingSecret", "DEVICE_PAIRING_SECRET"],
    ["jwtSecret", "JWT_SECRET"]
  ];
  return pairs.filter(([key]) => !config[key]).map(([, envName]) => envName);
}

export function loadConfig(): AppConfig {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const publicBaseUrl = optionalEnv("PUBLIC_BASE_URL") ?? `http://localhost:${Number.isFinite(port) ? port : 3000}`;
  const config: AppConfig = {
    nodeEnv: optionalEnv("NODE_ENV") ?? "development",
    port: Number.isFinite(port) ? port : 3000,
    publicBaseUrl,
    openaiApiKey: optionalEnv("OPENAI_API_KEY"),
    openaiFastModel: optionalEnv("OPENAI_FAST_MODEL") ?? "gpt-4.1-mini",
    openaiDeepModel: optionalEnv("OPENAI_DEEP_MODEL") ?? "gpt-5.5",
    deepgramApiKey: optionalEnv("DEEPGRAM_API_KEY"),
    telegramBotToken: optionalEnv("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: optionalEnv("TELEGRAM_WEBHOOK_SECRET"),
    ownerTelegramUserId: optionalEnv("OWNER_TELEGRAM_USER_ID"),
    googleClientId: optionalEnv("GOOGLE_CLIENT_ID"),
    googleClientSecret: optionalEnv("GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: optionalEnv("GOOGLE_REDIRECT_URI") ?? `${publicBaseUrl}/oauth/google/callback`,
    databaseUrl: optionalEnv("DATABASE_URL"),
    devicePairingSecret: optionalEnv("DEVICE_PAIRING_SECRET"),
    jwtSecret: optionalEnv("JWT_SECRET")
  };
  return config;
}

export function readiness(config: AppConfig) {
  const missing = requiredInProduction(config);
  return {
    ok: config.nodeEnv !== "production" || missing.length === 0,
    missing,
    configured: {
      openai: Boolean(config.openaiApiKey),
      deepgram: Boolean(config.deepgramApiKey),
      telegram: Boolean(config.telegramBotToken && config.telegramWebhookSecret && config.ownerTelegramUserId),
      google: Boolean(config.googleClientId && config.googleClientSecret),
      postgres: Boolean(config.databaseUrl),
      devicePairing: Boolean(config.devicePairingSecret),
      jwt: Boolean(config.jwtSecret)
    }
  };
}

