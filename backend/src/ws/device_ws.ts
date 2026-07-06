import type { RawData, WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { createServices } from "../services/index.js";
import type { DeepgramRealtimeSession } from "../services/deepgram_service.js";
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
    let latestFinalTranscript = "";

    const sendToThisDevice = (_targetDeviceId: string, event: BackendToDeviceEvent) => {
      send(socket, event);
      return true;
    };

    const heartbeat = setInterval(() => {
      if (authenticated) send(socket, { type: "pong", id: "backend-heartbeat", ts: Date.now() });
    }, 60_000);

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
          deepgramSession = services.deepgram.createRealtimeSession((out) => {
            send(socket, out);
            if (out.type === "transcript_final") latestFinalTranscript = out.text;
          });
          deepgramSession?.start(event.sample_rate, event.encoding);
          break;
        case "audio_chunk":
          deepgramSession?.sendAudio(Buffer.from(event.audio_b64, "base64"));
          break;
        case "audio_end":
          deepgramSession?.finish();
          deepgramSession = undefined;
          if (latestFinalTranscript.trim()) {
            send(socket, { type: "assistant_thinking", active: true });
            const reply = await services.openai.respond({
              userId: "owner",
              deviceId,
              text: latestFinalTranscript,
              mode: "voice"
            });
            send(socket, { type: "assistant_thinking", active: false });
            send(socket, { type: "response_text", text: reply });
            const tts = await services.tts.synthesizeShortReply(reply);
            for (const chunk of tts.chunks) {
              send(socket, { type: "tts_audio_chunk", audio_b64: chunk.toString("base64"), mime_type: tts.mimeType });
            }
            send(socket, { type: "tts_audio_end" });
          }
          break;
        case "text_input":
          if (event.text.trim()) {
            send(socket, { type: "assistant_thinking", active: true });
            const reply = await services.openai.respond({
              userId: "owner",
              deviceId,
              text: event.text,
              mode: event.mode ?? "voice"
            });
            send(socket, { type: "assistant_thinking", active: false });
            send(socket, { type: "response_text", text: reply });
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
          deepgramSession?.sendAudio(rawToBuffer(data));
          return;
        }
        const event = parseDeviceEvent(data.toString());
        if (!event) {
          send(socket, { type: "error", code: "bad_json", message: "Invalid device event." });
          return;
        }
        await handleEvent(event);
      })();
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      deepgramSession?.finish();
      if (deviceId) services.unregisterDevicePusher(deviceId);
      request.log.info({ deviceId }, "device websocket closed");
    });
  });
}
