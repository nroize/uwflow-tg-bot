#!/usr/bin/env node
// scripts/check-watchlists.mjs — the hourly watchlist sweep. Runs OUTSIDE
// Telegram Serverless (as a GitHub Actions cron job) because that platform
// has no scheduler of its own. Reads the same Upstash Redis store the bot
// writes to, checks every watched course against UW's official Schedule of
// Classes, and DMs anyone watching a course that just opened up.
//
// Requires Node >=18 (global fetch) and these env vars:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, TELEGRAM_BOT_TOKEN
//
// Run locally with: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//   TELEGRAM_BOT_TOKEN=... node scripts/check-watchlists.mjs

import { makeStore } from '../lib/store.js';
import { checkCourse, anySectionOpen, formatCourseStatus } from '../lib/uwSchedule.js';

const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, TELEGRAM_BOT_TOKEN } = process.env;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !TELEGRAM_BOT_TOKEN) {
  console.error('Missing required env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegramMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) {
    // A single bad chat (e.g. user blocked the bot) shouldn't kill the run.
    console.warn(`sendMessage to ${chatId} failed: ${data.description}`);
  }
}

async function main() {
  const store = makeStore({
    redisUrl: UPSTASH_REDIS_REST_URL,
    redisToken: UPSTASH_REDIS_REST_TOKEN,
    fetchImpl: fetch,
  });

  const watched = await store.allWatchedCourses();
  console.log(`Checking ${watched.length} watched course(s)...`);

  for (const { term, subject, catalog } of watched) {
    try {
      const watchers = await store.getWatchers(term, subject, catalog);
      if (watchers.length === 0) {
        console.log(`${subject} ${catalog}: no watchers left, skipping (should be cleaned up)`);
        continue;
      }

      const courses = await checkCourse(subject, catalog, term, fetch);
      const course = courses.find((c) => c.catalog.toUpperCase() === catalog.toUpperCase());
      if (!course) {
        console.warn(`${subject} ${catalog}: not found this term (renumbered/cancelled?)`);
        continue;
      }

      const isOpen = anySectionOpen(course);
      const lastState = await store.getLastState(term, subject, catalog);
      console.log(`${subject} ${catalog}: ${isOpen ? 'OPEN' : 'full'} (was ${lastState ?? 'unknown'}), ${watchers.length} watcher(s)`);

      if (isOpen && lastState !== 'open') {
        const text = `🚨 A seat just opened up!\n\n${formatCourseStatus(course)}`;
        for (const chatId of watchers) {
          await sendTelegramMessage(chatId, text);
        }
      }

      await store.setLastState(term, subject, catalog, isOpen ? 'open' : 'full');
    } catch (err) {
      // One course failing (network blip, parser drift) shouldn't stop the sweep.
      console.error(`${subject} ${catalog}: ${err.stack || err}`);
    }

    await sleep(500); // be polite to classes.uwaterloo.ca
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
