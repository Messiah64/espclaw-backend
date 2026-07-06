import type { GmailService } from "../services/gmail_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function gmailTools(gmail: GmailService): RegisteredTool[] {
  return [
    {
      name: "gmail_search",
      description: "Search Gmail messages for the user.",
      risk: "read_only",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      handler: (args, context) => gmail.search(context.userId, stringArg(args, "query"))
    },
    {
      name: "gmail_create_draft",
      description: "Create an email draft. Drafts are allowed without approval.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" }
        },
        required: ["to", "subject", "body"],
        additionalProperties: false
      },
      handler: (args, context) =>
        gmail.draft(context.userId, stringArg(args, "to"), stringArg(args, "subject"), stringArg(args, "body"))
    },
    {
      name: "gmail_send",
      description: "Send an email. Always requires Telegram approval before execution.",
      risk: "sensitive_write",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" }
        },
        required: ["to", "subject", "body"],
        additionalProperties: false
      },
      handler: (args, context) =>
        gmail.send(context.userId, stringArg(args, "to"), stringArg(args, "subject"), stringArg(args, "body"))
    }
  ];
}

