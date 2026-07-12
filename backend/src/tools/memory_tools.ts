import type { MemoryService } from "../services/memory_service.js";
import type { RegisteredTool } from "./tool_registry.js";
import { stringArg } from "./tool_registry.js";

export function memoryTools(memory: MemoryService): RegisteredTool[] {
  return [
    {
      name: "memory_remember",
      description: "Persist a stable user preference, fact, project detail, or instruction for future conversations.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false
      },
      handler: async (args, context) => {
        const key = stringArg(args, "key").trim().slice(0, 120);
        const value = stringArg(args, "value").trim().slice(0, 2000);
        if (!key || !value) return { ok: false, text: "Memory key and value are required." };
        await memory.remember(context.userId, key, value, "assistant_tool");
        return { ok: true, text: `Remembered ${key}.` };
      }
    },
    {
      name: "memory_recall",
      description: "Recall persistent user memory, optionally by an exact key.",
      risk: "read_only",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        additionalProperties: false
      },
      handler: async (args, context) => {
        const rows = await memory.recall(context.userId, stringArg(args, "key").trim() || undefined);
        return { ok: true, text: rows.length ? `Recalled ${rows.length} memories.` : "No matching memory.", data: rows };
      }
    },
    {
      name: "memory_forget",
      description: "Delete one persistent memory when the user explicitly asks to forget it.",
      risk: "low_risk_write",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false
      },
      handler: async (args, context) => {
        const key = stringArg(args, "key").trim();
        const removed = key ? await memory.forget(context.userId, key) : false;
        return { ok: removed, text: removed ? `Forgot ${key}.` : `No memory named ${key}.` };
      }
    }
  ];
}
