import type { ContactsService } from "../services/contacts_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function contactsTools(contacts: ContactsService): RegisteredTool[] {
  return [
    {
      name: "contacts_search",
      description: "Search Google Contacts.",
      risk: "read_only",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      handler: (args, context) => contacts.search(context.userId, stringArg(args, "query"))
    }
  ];
}

