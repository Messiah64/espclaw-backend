import type { DriveService } from "../services/drive_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function driveTools(drive: DriveService): RegisteredTool[] {
  return [
    {
      name: "drive_search",
      description: "Search Google Drive file metadata.",
      risk: "read_only",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Google Drive query string" } },
        required: ["query"],
        additionalProperties: false
      },
      handler: (args, context) => drive.search(context.userId, stringArg(args, "query"))
    }
  ];
}

