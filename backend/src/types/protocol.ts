export type DeviceToBackendEvent =
  | { type: "device_hello"; device_id: string; device_token: string; firmware?: string }
  | {
      type: "audio_start";
      conversation_id?: string;
      sample_rate?: number;
      encoding?: string;
      mode?: "push_to_talk" | "always";
      auto_respond?: boolean;
    }
  | { type: "audio_chunk"; audio_b64: string; sequence?: number }
  | { type: "audio_end" }
  | { type: "text_input"; text: string; mode?: "voice" | "deep" }
  | { type: "touch_to_talk"; active: boolean }
  | { type: "mute_toggle"; muted: boolean }
  | { type: "ping"; id?: string; ts?: number }
  | { type: "log"; level?: "debug" | "info" | "warn" | "error"; message: string; meta?: unknown };

export type BackendToDeviceEvent =
  | { type: "auth_ok"; device_id: string }
  | { type: "auth_failed"; reason: string }
  | { type: "state_update"; state: Record<string, unknown> }
  | { type: "transcript_interim"; text: string; latency_ms?: number }
  | { type: "transcript_final"; text: string; latency_ms?: number; speech_final?: boolean }
  | { type: "assistant_thinking"; active: boolean }
  | { type: "tool_call_started"; tool_call_id: string; tool_name: string }
  | { type: "tool_call_finished"; tool_call_id: string; tool_name: string; ok: boolean; summary?: string }
  | { type: "response_text"; text: string }
  | { type: "tts_audio_chunk"; audio_b64: string; mime_type: string }
  | { type: "tts_audio_end" }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; id?: string; ts?: number };

export function parseDeviceEvent(raw: string): DeviceToBackendEvent | null {
  try {
    const value = JSON.parse(raw) as { type?: unknown };
    return typeof value.type === "string" ? (value as DeviceToBackendEvent) : null;
  } catch {
    return null;
  }
}
