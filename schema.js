import { table, text } from 'sdk/db';

// Everything user-facing (watchlists, last-known course state) lives in
// Upstash Redis instead of here -- see lib/store.js for why: the hourly
// checker runs outside this sandbox (Telegram Serverless has no scheduler),
// and this DB isn't reachable from outside it.
//
// The one thing that *does* belong here: secrets. There's no env var /
// secrets mechanism in tgcloud (checked: no `tgcloud env` or similar CLI
// command exists), so the Upstash credentials are stored here instead of
// hardcoded in source -- set once via `npx tgcloud run handlers/_admin`,
// never committed. See lib/config.js and README.md.
export const config = table('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
