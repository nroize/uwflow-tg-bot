#!/usr/bin/env node
// scripts/watch-syde522-002.mjs — a dedicated, high-frequency (5 min) watch
// for one specific section: SYDE 522 LEC 002 (+ its paired TUT 102). Kept
// separate from scripts/check-watchlists.mjs (the general hourly multi-user
// bot, not wired up yet) on purpose: this is a single-user, single-section,
// time-critical chase (already in LEC 001, want to swap into LEC 002).
//
// Deliberately stateless: no DB, no state file, nothing committed back to
// the repo. If the section is open, it messages you -- every run, every 5
// minutes, for as long as it stays open. That's a feature here, not a bug:
// this is a short-lived, adversarial seat chase, and repeated pings until
// you actually act (or disable the workflow) beat silently going quiet.
//
// Requires Node >=18 (global fetch) and env vars: TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID (get yours by messaging your bot, then hitting
// api.telegram.org/bot<TOKEN>/getUpdates).

import { checkCourse, DEFAULT_TERM_ID } from '../lib/uwSchedule.js';

const SUBJECT = 'SYDE';
const CATALOG = '522';
const WATCHED_SECTIONS = ['LEC 002', 'TUT 102']; // both must have room to actually be enrollable

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

for (const [name, val] of Object.entries({ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

async function sendTelegramMessage(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendMessage failed: ${data.description}`);
}

async function main() {
  const courses = await checkCourse(SUBJECT, CATALOG, DEFAULT_TERM_ID, fetch);
  const course = courses.find((c) => c.catalog.toUpperCase() === CATALOG);
  if (!course) {
    console.error(`${SUBJECT} ${CATALOG}: not found this term`);
    process.exit(1);
  }

  const sections = WATCHED_SECTIONS.map((name) => course.sections.find((s) => s.sectionName.trim() === name));
  const missing = WATCHED_SECTIONS.filter((_, i) => !sections[i]);
  if (missing.length) {
    console.error(`Section(s) not found: ${missing.join(', ')}`);
    process.exit(1);
  }

  const statusLines = sections.map((s) => {
    const open = s.enrlCap > s.enrlTotal;
    return `${open ? '🟢' : '🔴'} ${s.sectionName} — ${open ? `${s.enrlCap - s.enrlTotal} open of ${s.enrlCap}` : `FULL (${s.enrlTotal}/${s.enrlCap})`}`;
  });
  console.log(statusLines.join(' | '));

  const allOpen = sections.every((s) => s.enrlCap > s.enrlTotal);
  if (allOpen) {
    await sendTelegramMessage(
      `🚨 *${SUBJECT} ${CATALOG}* — ${WATCHED_SECTIONS.join(' + ')} has room!\n\n${statusLines.join('\n')}\n\nGo grab it in Quest now. (You'll keep getting this every 5 min until it fills or you disable the workflow.)`
    );
    console.log('Notified.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
