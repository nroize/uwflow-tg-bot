// handlers/_admin.js — NOT a real Telegram update type (leading underscore
// is deliberate; Telegram will never deliver an update here). Manual-only,
// invoked via:
//
//   npx tgcloud run handlers/_admin '{"key":"UPSTASH_REDIS_REST_URL","value":"https://xxx.upstash.io"}'
//   npx tgcloud run handlers/_admin '{"key":"UPSTASH_REDIS_REST_TOKEN","value":"..."}'
//
// This is how secrets get into the bot without ever being committed to
// source -- see lib/config.js and README.md.

import { setConfig } from 'lib/config';

export default async function ({ key, value }) {
  if (!key || typeof value === 'undefined') {
    throw new Error('usage: npx tgcloud run handlers/_admin \'{"key": "...", "value": "..."}\'');
  }
  await setConfig(key, value);
  return { ok: true, key };
}
