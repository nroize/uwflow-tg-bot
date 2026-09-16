// lib/config.js — small key/value config store backed by this bot's own
// `db` (see schema.js for why: it's where secrets live, since tgcloud has
// no env var mechanism). tgcloud-only (imports 'sdk'), unlike the other
// lib/ modules -- this one is never used from the external checker script.

import { db } from 'sdk';
import { config } from 'schema';
import { eq } from 'sdk/db';

// Per-isolate cache -- harmless if the isolate is cold and this misses;
// just saves a DB round trip on a warm one.
const cache = new Map();

export async function getConfig(key) {
  if (cache.has(key)) return cache.get(key);
  const row = await db.select().from(config).where(eq(config.key, key)).get();
  const value = row ? row.value : null;
  cache.set(key, value);
  return value;
}

export async function setConfig(key, value) {
  await db.insert(config).values({ key, value })
    .onConflictDoUpdate({ target: config.key, set: { value } })
    .run();
  cache.set(key, value);
}
