// lib/store.js — watchlist storage over the Upstash Redis REST API.
//
// Why Redis and not this bot's own built-in `db`: the hourly checker runs
// as a GitHub Actions cron job *outside* Telegram Serverless (which has no
// scheduler of its own — see README.md), and Telegram Serverless's `db`
// isn't reachable from outside its own sandbox. Upstash's REST API is
// plain HTTPS, so both the bot (via tgcloud's `fetch`) and the external
// checker (via Node's global `fetch`) can read/write the exact same store.
// One source of truth, no sync problem.
//
// Portable like the other lib/ modules: no `sdk` import; call `makeStore`
// with an injected `fetchImpl`.
//
// Key layout:
//   all_courses                          SET of "term:subject:catalog"
//   watchers:{term}:{subject}:{catalog}   SET of chat_id (as strings)
//   user:{chatId}:courses                 SET of "term:subject:catalog"
//   laststate:{term}:{subject}:{catalog}  STRING "open" | "full"

function courseKey(term, subject, catalog) {
  return `${term}:${subject.toUpperCase()}:${catalog.toUpperCase()}`;
}

export function makeStore({ redisUrl, redisToken, fetchImpl }) {
  if (!redisUrl || !redisToken) {
    throw new Error('makeStore: redisUrl and redisToken are required');
  }
  const f = fetchImpl || globalThis.fetch;

  async function cmd(...args) {
    const res = await f(redisUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Redis error on ${args[0]}: ${data.error}`);
    return data.result;
  }

  return {
    async addWatch(chatId, term, subject, catalog) {
      const ck = courseKey(term, subject, catalog);
      await cmd('SADD', 'all_courses', ck);
      await cmd('SADD', `watchers:${ck}`, String(chatId));
      await cmd('SADD', `user:${chatId}:courses`, ck);
    },

    async removeWatch(chatId, term, subject, catalog) {
      const ck = courseKey(term, subject, catalog);
      await cmd('SREM', `watchers:${ck}`, String(chatId));
      await cmd('SREM', `user:${chatId}:courses`, ck);
      const remaining = await cmd('SCARD', `watchers:${ck}`);
      if (remaining === 0) {
        await cmd('SREM', 'all_courses', ck);
        await cmd('DEL', `laststate:${ck}`);
      }
    },

    /** -> [{ term, subject, catalog }] */
    async listWatches(chatId) {
      const raw = (await cmd('SMEMBERS', `user:${chatId}:courses`)) || [];
      return raw.map((ck) => {
        const [term, subject, catalog] = ck.split(':');
        return { term, subject, catalog };
      });
    },

    async watchCount(chatId) {
      return (await cmd('SCARD', `user:${chatId}:courses`)) || 0;
    },

    /** -> [chatId, ...] (strings) */
    async getWatchers(term, subject, catalog) {
      const ck = courseKey(term, subject, catalog);
      return (await cmd('SMEMBERS', `watchers:${ck}`)) || [];
    },

    /** -> [{ term, subject, catalog }] across all users */
    async allWatchedCourses() {
      const raw = (await cmd('SMEMBERS', 'all_courses')) || [];
      return raw.map((ck) => {
        const [term, subject, catalog] = ck.split(':');
        return { term, subject, catalog };
      });
    },

    /** -> 'open' | 'full' | null */
    async getLastState(term, subject, catalog) {
      const ck = courseKey(term, subject, catalog);
      return await cmd('GET', `laststate:${ck}`);
    },

    async setLastState(term, subject, catalog, state) {
      const ck = courseKey(term, subject, catalog);
      await cmd('SET', `laststate:${ck}`, state);
    },
  };
}
