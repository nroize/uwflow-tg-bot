// handlers/message.js — command router for every incoming DM/group message.
// Commands: /start /help /add /remove /list /rating /check

import { api } from 'sdk';
import { fetch } from 'sdk';
import { getConfig } from 'lib/config';
import { makeStore } from 'lib/store';
import { checkCourse, formatCourseStatus, anySectionOpen, DEFAULT_TERM_ID } from 'lib/uwSchedule';
import { getCourseRating, formatRating } from 'lib/uwflowRatings';

const MAX_WATCHES = 15;

const HELP = `*UWFlow Watchlist Bot*

/add SUBJECT NUMBER — watch a course for open seats (e.g. \`/add EARTH 122\`)
/remove SUBJECT NUMBER — stop watching a course
/list — show your watchlist with live status
/check — re-check your whole watchlist right now
/rating SUBJECT NUMBER — UWFlow ease/usefulness ratings for a course

Watched courses are auto-checked hourly. You'll get a message the moment a
seat opens up. Currently tracking term_id ${DEFAULT_TERM_ID}.

Seat data comes from UW's official Schedule of Classes (more current and
more accurate than UWFlow, including eligibility notes and reserved-seat
pools UWFlow doesn't show). Ratings come from UWFlow.`;

async function getStore() {
  const redisUrl = await getConfig('UPSTASH_REDIS_REST_URL');
  const redisToken = await getConfig('UPSTASH_REDIS_REST_TOKEN');
  if (!redisUrl || !redisToken) {
    throw new Error(
      'Bot is not fully configured: missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. ' +
      'See README.md — set them via `npx tgcloud run handlers/_admin`.'
    );
  }
  return makeStore({ redisUrl, redisToken, fetchImpl: fetch });
}

function parseArgs(text) {
  // "/add EARTH 122" -> ["EARTH", "122"]; tolerant of extra whitespace.
  return text.trim().split(/\s+/).slice(1);
}

async function reply(chatId, text) {
  await api.sendMessage({ chat_id: chatId, text, parse_mode: 'Markdown' });
}

async function cmdAdd(chatId, args) {
  const [subject, catalog] = args;
  if (!subject || !catalog) {
    return reply(chatId, 'Usage: `/add SUBJECT NUMBER`, e.g. `/add EARTH 122`');
  }
  const store = await getStore();
  const count = await store.watchCount(chatId);
  if (count >= MAX_WATCHES) {
    return reply(chatId, `You're already watching ${MAX_WATCHES} courses (the max). Remove one with /remove first.`);
  }

  const courses = await checkCourse(subject, catalog, DEFAULT_TERM_ID, fetch);
  const course = courses.find((c) => c.catalog.toUpperCase() === catalog.toUpperCase());
  if (!course) {
    return reply(chatId, `Couldn't find ${subject.toUpperCase()} ${catalog.toUpperCase()} for this term. Check the subject/number and try again.`);
  }

  await store.addWatch(chatId, DEFAULT_TERM_ID, subject, catalog);
  await store.setLastState(DEFAULT_TERM_ID, subject, catalog, anySectionOpen(course) ? 'open' : 'full');

  return reply(chatId, `👀 Now watching *${subject.toUpperCase()} ${catalog.toUpperCase()}*. Current status:\n\n${formatCourseStatus(course)}`);
}

async function cmdRemove(chatId, args) {
  const [subject, catalog] = args;
  if (!subject || !catalog) {
    return reply(chatId, 'Usage: `/remove SUBJECT NUMBER`, e.g. `/remove EARTH 122`');
  }
  const store = await getStore();
  await store.removeWatch(chatId, DEFAULT_TERM_ID, subject, catalog);
  return reply(chatId, `Stopped watching ${subject.toUpperCase()} ${catalog.toUpperCase()}.`);
}

async function cmdList(chatId) {
  const store = await getStore();
  const watches = await store.listWatches(chatId);
  if (watches.length === 0) {
    return reply(chatId, "You're not watching any courses yet. Add one with `/add SUBJECT NUMBER`.");
  }
  await reply(chatId, `Checking your ${watches.length} watched course(s)...`);
  const blocks = [];
  for (const w of watches) {
    const courses = await checkCourse(w.subject, w.catalog, w.term, fetch);
    const course = courses.find((c) => c.catalog.toUpperCase() === w.catalog.toUpperCase());
    blocks.push(course ? formatCourseStatus(course) : `*${w.subject} ${w.catalog}* — not found this term`);
  }
  return reply(chatId, blocks.join('\n\n'));
}

async function cmdCheck(chatId) {
  return cmdList(chatId); // same live-check logic, just framed as a manual refresh
}

async function cmdRating(chatId, args) {
  const [subject, catalog] = args;
  if (!subject || !catalog) {
    return reply(chatId, 'Usage: `/rating SUBJECT NUMBER`, e.g. `/rating SCI 238`');
  }
  const course = await getCourseRating(subject, catalog, fetch);
  return reply(chatId, formatRating(course));
}

export default async function (message) {
  const chatId = message.chat.id;
  const text = message.text ?? '';

  if (!text.startsWith('/')) {
    return reply(chatId, "I only understand commands. Try /help.");
  }

  const command = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const args = parseArgs(text);

  try {
    switch (command) {
      case '/start':
      case '/help':
        return reply(chatId, HELP);
      case '/add':
        return await cmdAdd(chatId, args);
      case '/remove':
        return await cmdRemove(chatId, args);
      case '/list':
        return await cmdList(chatId);
      case '/check':
        return await cmdCheck(chatId);
      case '/rating':
        return await cmdRating(chatId, args);
      default:
        return reply(chatId, "Unknown command. Try /help.");
    }
  } catch (err) {
    console.error(err);
    return reply(chatId, `Something went wrong: ${err.message}`);
  }
}
