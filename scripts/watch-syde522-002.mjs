#!/usr/bin/env node
// scripts/watch-syde522-002.mjs — a dedicated, high-frequency (5 min) check
// covering two things for one specific course-switch decision:
//   1. SYDE 522 LEC 002 (+ paired TUT 102) opening up -- the section being
//      chased as a swap out of LEC 001's weekly quizzes + mandatory group
//      project.
//   2. ECE 457B LEC 001 (+ paired TUT 101) running low on seats -- the
//      fallback course, in case it fills before SYDE522-002 does.
// Both live in one script/workflow since they share the same 5-min cadence
// and it's one extra HTTP call, not a second deployment.
//
// Deliberately stateless: no DB, no state file, nothing committed back to
// the repo. Each condition re-fires every run for as long as it holds true
// -- a feature here, not a bug: this is a short-lived, adversarial decision
// window, and repeated pings until you act (or disable the workflow) beat
// silently going quiet.
//
// Requires Node >=18 (global fetch) and env vars: TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID (get yours by messaging your bot, then hitting
// api.telegram.org/bot<TOKEN>/getUpdates).

import { checkCourse, DEFAULT_TERM_ID } from '../lib/uwSchedule.js';

const SYDE_SUBJECT = 'SYDE';
const SYDE_CATALOG = '522';
const SYDE_SECTIONS = ['LEC 002', 'TUT 102']; // both must have room to actually be enrollable

const FALLBACK_SUBJECT = 'ECE';
const FALLBACK_CATALOG = '457B';
const FALLBACK_SECTIONS = ['LEC 001', 'TUT 101'];
const FALLBACK_LOW_SEATS_THRESHOLD = 10;

// Copy-pasteable registrar email. Telegram inline-keyboard buttons reject
// `mailto:` URLs outright (BUTTON_URL_INVALID), and mailto: links inside
// message text render but don't reliably hand off to a mail client either
// -- confirmed broken in practice. Code-block formatting (tap-to-copy in
// Telegram) is the reliable alternative, so each field is copied and
// pasted by hand instead of relying on a client-side URI handler.
const REGISTRAR_EMAIL = 'registrar@uwaterloo.ca';
const EMAIL_SUBJECT = 'Section Change Request – SYDE 522 (LEC 001 to LEC 002), Fall 2026';
const EMAIL_BODY = `To the Office of the Registrar,

I am currently enrolled in SYDE 522 (Foundations of AI) for the Fall 2026 term and would like to request a section change from LEC 001 to LEC 002 (with the corresponding TUT 102).

Please let me know if you require any further information to process this request. Thank you for your time and assistance.

Sincerely,
[Your Full Name]
Student ID: [Your Student ID]`;

function emailBlock() {
  return [
    '📧 *Section switch email* (tap each block to copy):',
    '',
    '*To:*',
    '```',
    REGISTRAR_EMAIL,
    '```',
    '*Subject:*',
    '```',
    EMAIL_SUBJECT,
    '```',
    '*Body:*',
    '```',
    EMAIL_BODY,
    '```',
  ].join('\n');
}

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

function statusLine(s, open) {
  return `${open ? '🟢' : '🔴'} ${s.sectionName} — ${open ? `${s.enrlCap - s.enrlTotal} open of ${s.enrlCap}` : `FULL (${s.enrlTotal}/${s.enrlCap})`}`;
}

async function fetchWatchedSections(subject, catalog, sectionNames) {
  const courses = await checkCourse(subject, catalog, DEFAULT_TERM_ID, fetch);
  const course = courses.find((c) => c.catalog.toUpperCase() === catalog.toUpperCase());
  if (!course) throw new Error(`${subject} ${catalog}: not found this term`);
  const sections = sectionNames.map((name) => course.sections.find((s) => s.sectionName.trim() === name));
  const missing = sectionNames.filter((_, i) => !sections[i]);
  if (missing.length) throw new Error(`${subject} ${catalog}: section(s) not found: ${missing.join(', ')}`);
  return sections;
}

async function checkSyde522Opening() {
  const sections = await fetchWatchedSections(SYDE_SUBJECT, SYDE_CATALOG, SYDE_SECTIONS);
  const lines = sections.map((s) => statusLine(s, s.enrlCap > s.enrlTotal));
  console.log(`[${SYDE_SUBJECT} ${SYDE_CATALOG}] ${lines.join(' | ')}`);

  const allOpen = sections.every((s) => s.enrlCap > s.enrlTotal);
  if (allOpen) {
    await sendTelegramMessage(
      `🚨 *${SYDE_SUBJECT} ${SYDE_CATALOG}* — ${SYDE_SECTIONS.join(' + ')} has room!\n\n${lines.join('\n')}\n\nGo grab it in Quest now. (You'll keep getting this every 5 min until it fills or you disable the workflow.)\n\n${emailBlock()}`
    );
    console.log('SYDE522 opening notification sent.');
  }
}

async function checkEce457bFallbackSeats() {
  const sections = await fetchWatchedSections(FALLBACK_SUBJECT, FALLBACK_CATALOG, FALLBACK_SECTIONS);
  const openCounts = sections.map((s) => Math.max(0, s.enrlCap - s.enrlTotal));
  const lines = sections.map((s, i) => statusLine(s, openCounts[i] > 0));
  console.log(`[${FALLBACK_SUBJECT} ${FALLBACK_CATALOG}] ${lines.join(' | ')}`);

  const minOpen = Math.min(...openCounts);
  if (minOpen <= FALLBACK_LOW_SEATS_THRESHOLD) {
    await sendTelegramMessage(
      `⚠️ *${FALLBACK_SUBJECT} ${FALLBACK_CATALOG}* (your fallback) is running low!\n\n${lines.join('\n')}\n\nIf SYDE522-002 hasn't opened up yet and you're relying on this as a backup, don't wait too long. (You'll keep getting this every 5 min while seats stay at or below ${FALLBACK_LOW_SEATS_THRESHOLD}.)`
    );
    console.log('ECE457B low-seats warning sent.');
  }
}

async function main() {
  if (process.env.TEST_NOTIFY === 'true') {
    await sendTelegramMessage(
      `🧪 Test notification, triggered manually — if you got this, the send path works end-to-end from GitHub Actions.\n\n${emailBlock()}`
    );
    console.log('Test notification sent.');
    return;
  }

  // Each check is independent -- a failure in one (transient network issue,
  // a parser hiccup) shouldn't prevent the other from running.
  const results = await Promise.allSettled([checkSyde522Opening(), checkEce457bFallbackSeats()]);
  for (const r of results) {
    if (r.status === 'rejected') console.error(r.reason);
  }
  if (results.every((r) => r.status === 'rejected')) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
