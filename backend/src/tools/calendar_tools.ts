import type { CalendarService } from "../services/calendar_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function calendarTools(calendar: CalendarService): RegisteredTool[] {
  return [
    {
      name: "calendar_list_upcoming",
      description: "List upcoming Google Calendar events.",
      risk: "read_only",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: (_args, context) => calendar.listUpcoming(context.userId)
    },
    {
      name: "calendar_create_event",
      description: "Create a calendar event. High-confidence creations can proceed; otherwise Telegram approval is required.",
      risk: "sensitive_write",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          start: { type: "string", description: "ISO timestamp" },
          end: { type: "string", description: "ISO timestamp" },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["summary", "start", "end", "confidence"],
        additionalProperties: false
      },
      handler: (args, context) =>
        calendar.createEvent(
          context.userId,
          stringArg(args, "summary"),
          stringArg(args, "start"),
          stringArg(args, "end"),
          (stringArg(args, "confidence", "low") as "low" | "medium" | "high")
        )
    }
  ];
}

