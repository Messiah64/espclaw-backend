import type { MonitorService } from "../services/monitor_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function monitorTools(monitors: MonitorService): RegisteredTool[] {
  return [
    {
      name: "notification_watch_gmail",
      description: "Continuously watch a Gmail search query and notify the user on Telegram and the device when results change.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, label: { type: "string" } },
        required: ["query", "label"],
        additionalProperties: false
      },
      handler: (args, context) => monitors.createGmail(context.userId, stringArg(args, "query"), stringArg(args, "label"))
    },
    {
      name: "notification_list",
      description: "List active notification watches.",
      risk: "read_only",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: (_args, context) => monitors.list(context.userId)
    },
    {
      name: "notification_stop",
      description: "Stop a notification watch by monitor ID.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: { monitor_id: { type: "string" } },
        required: ["monitor_id"],
        additionalProperties: false
      },
      handler: (args, context) => monitors.disable(context.userId, stringArg(args, "monitor_id"))
    }
  ];
}
