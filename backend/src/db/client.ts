import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyBaseLogger } from "fastify";
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

export async function ensureDatabaseSchema(pool: pg.Pool | undefined, logger?: FastifyBaseLogger): Promise<void> {
  if (!pool) return;
  const sql = `
    create extension if not exists pgcrypto;

    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      telegram_user_id text unique,
      display_name text,
      created_at timestamptz not null default now()
    );

    create table if not exists devices (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      device_id text not null unique,
      token_hash text not null,
      label text,
      last_seen_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists oauth_accounts (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      provider text not null,
      provider_account_id text,
      email text,
      created_at timestamptz not null default now()
    );
    create index if not exists oauth_accounts_provider_idx on oauth_accounts(provider);

    create table if not exists oauth_tokens (
      id uuid primary key default gen_random_uuid(),
      oauth_account_id uuid references oauth_accounts(id),
      access_token_ciphertext text,
      refresh_token_ciphertext text,
      scope text,
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists conversations (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      device_id uuid references devices(id),
      transcript jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists memories (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      owner_key text not null default 'owner',
      key text not null,
      value text not null,
      source text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table memories add column if not exists owner_key text not null default 'owner';
    create unique index if not exists memories_owner_key_key_idx on memories(owner_key, key);

    create table if not exists conversation_messages (
      id uuid primary key default gen_random_uuid(),
      owner_key text not null default 'owner',
      device_id text,
      role text not null,
      content text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists conversation_messages_owner_created_idx
      on conversation_messages(owner_key, created_at desc);

    create table if not exists action_logs (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      device_id uuid references devices(id),
      owner_key text,
      device_key text,
      action text not null,
      risk text not null,
      status text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    alter table action_logs add column if not exists owner_key text;
    alter table action_logs add column if not exists device_key text;

    create table if not exists pending_approvals (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references users(id),
      owner_key text not null default 'owner',
      action text not null,
      risk text not null,
      payload jsonb not null default '{}'::jsonb,
      approved boolean not null default false,
      decided_at timestamptz,
      created_at timestamptz not null default now()
    );
    alter table pending_approvals add column if not exists owner_key text not null default 'owner';

    create table if not exists agent_monitors (
      id uuid primary key default gen_random_uuid(),
      owner_key text not null default 'owner',
      kind text not null,
      query text not null,
      label text,
      last_fingerprint text,
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists agent_monitors_owner_enabled_idx on agent_monitors(owner_key, enabled);
  `;
  await pool.query(sql);
  logger?.info("database schema ready");
}
