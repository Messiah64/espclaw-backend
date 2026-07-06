import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { memories } from "../db/schema.js";

const fallbackMemories = new Map<string, string>();

export class MemoryService {
  constructor(private readonly db: DbClient | undefined) {}

  async remember(userId: string, key: string, value: string, source = "assistant"): Promise<void> {
    if (!this.db) {
      fallbackMemories.set(`${userId}:${key}`, value);
      return;
    }
    const existing = await this.db.select().from(memories).where(and(eq(memories.userId, userId), eq(memories.key, key))).limit(1);
    if (existing.length) {
      await this.db.update(memories).set({ value, source, updatedAt: new Date() }).where(eq(memories.id, existing[0]!.id));
    } else {
      await this.db.insert(memories).values({ userId, key, value, source });
    }
  }

  async recall(userId: string, key?: string): Promise<Array<{ key: string; value: string }>> {
    if (!this.db) {
      const prefix = `${userId}:`;
      return [...fallbackMemories.entries()]
        .filter(([k]) => k.startsWith(prefix) && (!key || k === `${userId}:${key}`))
        .map(([k, value]) => ({ key: k.slice(prefix.length), value }));
    }
    const rows = key
      ? await this.db.select().from(memories).where(and(eq(memories.userId, userId), eq(memories.key, key))).limit(20)
      : await this.db.select().from(memories).where(eq(memories.userId, userId)).limit(20);
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }
}

