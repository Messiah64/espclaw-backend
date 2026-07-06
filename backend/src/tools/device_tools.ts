import type { BackendToDeviceEvent } from "../types/protocol.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export type DevicePush = (deviceId: string, event: BackendToDeviceEvent) => boolean;

export function deviceTools(pushToDevice: DevicePush): RegisteredTool[] {
  return [
    {
      name: "device_show_text",
      description: "Display concise text on the paired ESP32 screen.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string" },
          text: { type: "string" }
        },
        required: ["device_id", "text"],
        additionalProperties: false
      },
      handler: async (args) => {
        const ok = pushToDevice(stringArg(args, "device_id"), { type: "response_text", text: stringArg(args, "text") });
        return { ok, text: ok ? "Text sent to device." : "Device is not connected." };
      }
    }
  ];
}

