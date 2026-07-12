import type { RawData, WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { createServices } from "../services/index.js";
import type { DeepgramRealtimeSession } from "../services/deepgram_service.js";
import type { RealtimeVoiceSession } from "../services/realtime_voice_service.js";
import type { BackendToDeviceEvent, DeviceToBackendEvent } from "../types/protocol.js";
import { parseDeviceEvent } from "../types/protocol.js";

function send(socket: WebSocket, event: BackendToDeviceEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function registerDeviceWebSocket(
  server: FastifyInstance,
  _config: AppConfig,
  services: ReturnType<typeof createServices>
) {
  server.get("/device/ws", { websocket: true }, (socket, request) => {
    let authenticated = false;
    let deviceId = "";
    let deepgramSession: DeepgramRealtimeSession | undefined;
    let realtimeSession: RealtimeVoiceSession | undefined;
    let latestFinalTranscript = "";
    let pendingTranscript = "";
    let audioAutoRespond = false;
    let assistantBusy = false;
    let transcriptTimer: ReturnType<typeof setTimeout> | undefined;

    const sendToThisDevice = (_targetDeviceId: string, event: BackendToDeviceEvent) => {
      send(socket, event);
      return true;
    };

    const heartbeat = setInterval(() => {
      if (authenticated) send(socket, { type: "pong", id: "backend-heartbeat", ts: Date.now() });
    }, 60_000);

    async function runAssistantForText(text: string, mode: "voice" | "deep" = "voice") {
      const trimmed = text.trim();
      if (!trimmed || assistantBusy) return;
      assistantBusy = true;
      try {
        send(socket, { type: "assistant_thinking", active: true });
        const reply = await services.openai.respond({
          userId: "owner",
          deviceId,
          text: trimmed,
          mode
        });
        send(socket, { type: "response_text", text: reply });
        if (_config.assistantVoiceOutputEnabled) {
          const tts = await services.tts.synthesizeShortReply(reply);
          for (const chunk of tts.chunks) {
            send(socket, { type: "tts_audio_chunk", audio_b64: chunk.toString("base64"), mime_type: tts.mimeType });
          }
          send(socket, { type: "tts_audio_end" });
        }
      } catch (error) {
        request.log.error({ error, deviceId }, "assistant response failed");
        send(socket, { type: "error", code: "assistant_failed", message: "Assistant response failed." });
      } finally {
        assistantBusy = false;
        send(socket, { type: "assistant_thinking", active: false });
      }
    }

    function clearTranscriptTimer() {
      if (transcriptTimer) {
        clearTimeout(transcriptTimer);
        transcriptTimer = undefined;
      }
    }

    async function startDeepgramFallback(event: Extract<DeviceToBackendEvent, { type: "audio_start" }>) {
      deepgramSession = services.deepgram.createRealtimeSession((out) => {
        send(socket, out);
        if (out.type === "transcript_final") {
          latestFinalTranscript = out.text;
          if (audioAutoRespond) scheduleAlwaysReply(out.text, out.speech_final);
        }
      });
      deepgramSession?.start(event.sample_rate, event.encoding);
      send(socket, {
        type: "state_update",
        state: {
          audio_streaming: Boolean(deepgramSession),
          audio_mode: audioAutoRespond ? "always" : "push_to_talk",
          audio_provider: "deepgram"
        }
      });
    }

    function scheduleAlwaysReply(text: string, speechFinal = false) {
      const trimmed = text.trim();
      if (!trimmed || trimmed.length < 3) return;
      pendingTranscript = [pendingTranscript, trimmed].filter(Boolean).join(" ").slice(-2000);
      clearTranscriptTimer();
      transcriptTimer = setTimeout(() => {
        const prompt = pendingTranscript.trim();
        pendingTranscript = "";
        void runAssistantForText(prompt, "voice");
      }, speechFinal ? 200 : 700);
    }

    async function authenticate(event: Extract<DeviceToBackendEvent, { type: "device_hello" }>) {
      const ok = await services.deviceAuth.verify(event.device_id, event.device_token);
      if (!ok) {
        send(socket, { type: "auth_failed", reason: "invalid_device_credentials" });
        socket.close();
        return;
      }
      authenticated = true;
      deviceId = event.device_id;
      services.registerDevicePusher(deviceId, sendToThisDevice);
      send(socket, { type: "auth_ok", device_id: deviceId });
      send(socket, { type: "state_update", state: { connected: true, firmware: event.firmware ?? "unknown" } });
      request.log.info({ deviceId }, "device websocket authenticated");
    }

    async function handleEvent(event: DeviceToBackendEvent) {
      if (!authenticated) {
        if (event.type === "device_hello") {
          await authenticate(event);
          return;
        }
        send(socket, { type: "auth_failed", reason: "send_device_hello_first" });
        return;
      }

      switch (event.type) {
        case "ping":
          send(socket, { type: "pong", id: event.id, ts: Date.now() });
          break;
        case "log":
          request.log.info({ deviceId, level: event.level, meta: event.meta }, event.message);
          break;
        case "touch_to_talk":
          send(socket, { type: "state_update", state: { touch_to_talk: event.active } });
          break;
        case "mute_toggle":
          send(socket, { type: "state_update", state: { muted: event.muted } });
          break;
        case "audio_start":
          latestFinalTranscript = "";
          pendingTranscript = "";
          audioAutoRespond = event.mode === "always" || event.auto_respond === true;
          clearTranscriptTimer();
          realtimeSession?.finish();
          deepgramSession?.finish();
          realtimeSession = undefined;
          deepgramSession = undefined;
          if (services.realtimeVoice.isConfigured()) {
            realtimeSession = services.realtimeVoice.createSession({
              userId: "owner",
              deviceId,
              sampleRate: event.sample_rate ?? 24000,
              autoRespond: audioAutoRespond,
              send: (out) => send(socket, out),
              onFinalTranscript: (text) => {
                latestFinalTranscript = text;
                if (audioAutoRespond) scheduleAlwaysReply(text, true);
              }
            });
            try {
              await realtimeSession?.start();
              send(socket, {
                type: "state_update",
                state: {
                  audio_streaming: true,
                  audio_mode: audioAutoRespond ? "always" : "push_to_talk",
                  audio_provider: "openai_realtime"
                }
              });
            } catch (error) {
              request.log.error({ error, deviceId }, "openai realtime start failed; falling back to deepgram");
              realtimeSession?.finish();
              realtimeSession = undefined;
              send(socket, {
                type: "error",
                code: "openai_realtime_start_failed",
                message: "OpenAI Realtime failed to start; falling back to Deepgram transcription."
              });
              await startDeepgramFallback(event);
            }
          } else {
            await startDeepgramFallback(event);
          }
          break;
        case "audio_chunk":
          if (realtimeSession) {
            await realtimeSession.sendAudio(Buffer.from(event.audio_b64, "base64"));
          } else {
            deepgramSession?.sendAudio(Buffer.from(event.audio_b64, "base64"));
          }
          break;
        case "audio_end":
          clearTranscriptTimer();
          if (realtimeSession) {
            await realtimeSession.stopInput();
            realtimeSession = undefined;
            send(socket, { type: "state_update", state: { audio_streaming: false } });
          } else {
            deepgramSession?.finish();
            deepgramSession = undefined;
            send(socket, { type: "state_update", state: { audio_streaming: false } });
            if (latestFinalTranscript.trim()) await runAssistantForText(latestFinalTranscript, "voice");
          }
          break;
        case "text_input":
          if (event.text.trim()) {
            await runAssistantForText(event.text, event.mode ?? "voice");
          }
          break;
        default:
          send(socket, { type: "error", code: "unknown_event", message: `Unhandled event ${event.type}` });
          break;
      }
    }

    socket.on("message", (data, isBinary) => {
      void (async () => {
        if (isBinary) {
          if (realtimeSession) {
            await realtimeSession.sendAudio(rawToBuffer(data));
          } else {
            deepgramSession?.sendAudio(rawToBuffer(data));
          }
          return;
        }
        const event = parseDeviceEvent(data.toString());
        if (!event) {
          send(socket, { type: "error", code: "bad_json", message: "Invalid device event." });
          return;
        }
        await handleEvent(event);
      })().catch((error) => {
        request.log.error({ error, deviceId }, "device websocket message failed");
        send(socket, {
          type: "error",
          code: "device_ws_message_failed",
          message: "Device websocket message failed; reconnecting may recover."
        });
      });
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      clearTranscriptTimer();
      realtimeSession?.finish();
      deepgramSession?.finish();
      if (deviceId) services.unregisterDevicePusher(deviceId);
      request.log.info({ deviceId }, "device websocket closed");
    });
  });
}
