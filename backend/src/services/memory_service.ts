import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { conversationMessages, memories } from "../db/schema.js";

const fallbackMemories = new Map<string, string>();

export class MemoryService {
  constructor(private readonly db: DbClient | undefined) {}

  async remember(userId: string, key: string, value: string, source = "assistant"): Promise<void> {
    if (!this.db) {
      fallbackMemories.set(`${userId}:${key}`, value);
      return;
    }
    const existing = await this.db.select().from(memories).where(and(eq(memories.ownerKey, userId), eq(memories.key, key))).limit(1);
    if (existing.length) {
      await this.db.update(memories).set({ value, source, updatedAt: new Date() }).where(eq(memories.id, existing[0]!.id));
    } else {
      await this.db.insert(memories).values({ ownerKey: userId, key, value, source });
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
      ? await this.db.select().from(memories).where(and(eq(memories.ownerKey, userId), eq(memories.key, key))).limit(20)
      : await this.db.select().from(memories).where(eq(memories.ownerKey, userId)).limit(20);
    return rows.map((row) => ({ key: row.key, value: row.value }));
  }

  async forget(userId: string, key: string): Promise<boolean> {
    if (!this.db) return fallbackMemories.delete(`${userId}:${key}`);
    const rows = await this.db.delete(memories)
      .where(and(eq(memories.ownerKey, userId), eq(memories.key, key)))
      .returning({ id: memories.id });
    return rows.length > 0;
  }

  async appendConversation(userId: string, deviceId: string | undefined, role: "user" | "assistant", content: string): Promise<void> {
    const trimmed = content.trim().slice(0, 8000);
    if (!trimmed || !this.db) return;
    await this.db.insert(conversationMessages).values({
      ownerKey: userId,
      deviceId,
      role,
      content: trimmed
    });
  }

  async recentConversation(userId: string, limit = 8): Promise<Array<{ role: string; content: string }>> {
    if (!this.db) return [];
    const rows = await this.db.select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.ownerKey, userId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(Math.max(1, Math.min(limit, 20)));
    return rows.reverse();
  }
}
