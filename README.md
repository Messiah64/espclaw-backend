# ESPClaw Render Backend

Render-hosted backend for an ESP32-S3-BOX-3B ESP-Claw desktop assistant. The ESP32 stores only:

- `BACKEND_URL`
- `DEVICE_ID`
- `DEVICE_TOKEN`

All sensitive provider credentials stay on the backend as Render environment variables.

## What This Backend Handles

- Device WebSocket connection at `WS /device/ws`
- Device pairing at `POST /device/pair`
- Deepgram realtime speech transcription relay
- OpenAI assistant reasoning and tool calling
- Telegram webhook approval bot
- Google OAuth for Gmail, Calendar, Drive, and Contacts tools
- Permission/risk checks for sensitive actions
- Postgres-backed token storage, memories, action logs, and pending approvals
- Health checks for Render and UptimeRobot

## Local Setup

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The server starts on `http://localhost:3000` by default.

Health check:

```bash
curl http://localhost:3000/healthz
```

Readiness check:

```bash
curl http://localhost:3000/readyz
```

`/healthz` never calls the database or external APIs. It is safe for uptime monitors.

## Environment Variables

Set these in Render, not in git:

- `OPENAI_API_KEY`
- `OPENAI_FAST_MODEL`
- `OPENAI_DEEP_MODEL`
- `DEEPGRAM_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_USER_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `DATABASE_URL`
- `DEVICE_PAIRING_SECRET`
- `JWT_SECRET`
- `NODE_ENV`
- `PUBLIC_BASE_URL`

`OPENAI_FAST_MODEL` is used for voice latency. `OPENAI_DEEP_MODEL` is used for complex tool-heavy tasks.

## Render Deployment

The Render blueprint is at:

```bash
backend/render.yaml
```

It defines one free Node web service:

- Build command: `npm ci && npm run build`
- Start command: `npm run start`
- Health check path: `/healthz`
- Region: Singapore

With Render MCP, create the service from the Git repository and set the environment variable names. Secret values should be set manually in the Render dashboard or with the MCP environment update tool.

## Telegram Webhook

The webhook endpoint is:

```text
POST /telegram/webhook/:secret
```

Set the webhook after deployment:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{\"url\":\"https://<render-service-url>/telegram/webhook/$TELEGRAM_WEBHOOK_SECRET\"}"
```

Supported owner-only commands:

- `/start`
- `/status`
- `/connect_google`
- `/revoke_google`
- `/approve <id>`
- `/deny <id>`
- `/mute`
- `/unmute`
- `/always_stream_on`
- `/always_stream_off`
- `/logs`
- `/help`

## Google OAuth

Set `GOOGLE_REDIRECT_URI` to:

```text
https://<render-service-url>/oauth/google/callback
```

Then open:

```text
https://<render-service-url>/oauth/google/start
```

Refresh tokens are stored in Postgres through the `oauth_tokens` table. Do not use Render local filesystem for tokens.

## Pair ESP32

Pair once:

```bash
curl -X POST "https://<render-service-url>/device/pair" \
  -H "content-type: application/json" \
  -d '{"pairing_secret":"<DEVICE_PAIRING_SECRET>","label":"ESP32-S3-BOX-3B"}'
```

The response contains:

```json
{
  "backend_url": "https://<render-service-url>",
  "device_id": "espclaw_...",
  "device_token": "..."
}
```

Store only those values on the ESP32.

## WebSocket Protocol

ESP32 connects to:

```text
wss://<render-service-url>/device/ws
```

First message:

```json
{
  "type": "device_hello",
  "device_id": "...",
  "device_token": "..."
}
```

Then send `audio_start`, `audio_chunk`, `audio_end`, `touch_to_talk`, `mute_toggle`, `ping`, and `log` events. The backend sends `auth_ok`, transcript events, assistant state, tool call status, response text, TTS chunks, errors, and `pong`.

The backend also emits a heartbeat `pong` every 60 seconds while the ESP32 is connected.

## UptimeRobot Keep-Alive

Point UptimeRobot to:

```text
https://<render-service-url>/healthz
```

Use a 10-minute interval. This avoids waking the database or external APIs.

## Security Model

- The ESP32 never stores OpenAI, Deepgram, Google, or Telegram secrets.
- Telegram webhook requests must include the correct route secret.
- Telegram commands are accepted only from `OWNER_TELEGRAM_USER_ID`.
- Device access requires `DEVICE_ID` and `DEVICE_TOKEN`.
- Read-only actions are allowed by default.
- Draft creation is allowed by default.
- Email sending requires Telegram approval.
- Destructive actions require Telegram approval.
- Calendar creation is allowed only when confidence is high; otherwise it goes to approval.
- No actual secrets are committed to git.

## Render Free-Tier Limitations

- Free web services may spin down when idle.
- Cold starts can delay voice interactions.
- Persistent local files are not reliable; use Postgres for state.
- UptimeRobot can reduce, but not fully eliminate, cold-start behavior.

## Known Risks

- OAuth token encryption should be hardened before production use.
- Database migrations are not wired yet; the Drizzle schema is present, but migration generation should be added before launch.
- TTS routing is stubbed and ready for a provider implementation.
- Google write actions currently stop at approval boundaries and should execute only after the approval worker is completed.
- Render MCP service creation requires a Git repository URL that Render can clone.

## Next Steps

1. Add Drizzle migration generation and apply migrations to Render Postgres.
2. Complete encrypted token storage with KMS or strong app-level encryption.
3. Implement the approval executor for approved pending actions.
4. Add provider-backed TTS streaming.
5. Add an ESP32 firmware client for this WebSocket protocol.

