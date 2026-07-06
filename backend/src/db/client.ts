import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type DbClient = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl?: string): { db?: DbClient; pool?: pg.Pool } {
  if (!databaseUrl) return {};
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000
  });
  return { db: drizzle(pool, { schema }), pool };
}

