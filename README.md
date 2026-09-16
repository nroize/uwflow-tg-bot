# uwflow-tg-bot

A Telegram bot for University of Waterloo course watchlists: `/add SUBJECT
NUMBER` to watch a course, get DMed the moment a seat opens, `/rating` for
UWFlow's crowdsourced course ratings. Multi-user, lightweight, hosted on
[Telegram Serverless](https://core.telegram.org/bots/serverless).

## Why this isn't 100% "on Telegram Serverless"

Telegram Serverless is genuinely great for the interactive half of this bot
(no server to run, a built-in DB, `fetch` for outbound calls) — but it's
**purely request-driven**: handlers only fire on an incoming Telegram
update (`message`, `callback_query`, `inline_query`). There is no cron,
timer, or scheduled-execution primitive at all (confirmed against the
official docs and the CLI's command list — no `env`/`schedule`/`cron`
command exists). So "check hourly" cannot run inside it.

The fix: a tiny **GitHub Actions workflow** (free, `cron: '0 * * * *'`) does
the hourly sweep instead. Both halves share one datastore — **Upstash
Redis** (free tier, plain HTTPS REST API) — since Telegram Serverless's own
`db` isn't reachable from outside its sandbox, and Upstash's REST API is
callable from both `fetch` environments with zero extra dependencies.

```
┌─────────────────────┐        shared         ┌──────────────────────┐
│  Telegram Serverless │ ◄──── Upstash ─────►  │  GitHub Actions cron │
│  (this repo, pushed  │       Redis            │  (this repo, runs    │
│  via tgcloud)         │      (watchlists,     │  scripts/check-      │
│                       │       last state)      │  watchlists.mjs)     │
│  /add /remove /list   │                        │  hourly sweep +      │
│  /rating /check        │                        │  Telegram notify     │
└─────────────────────┘                        └──────────────────────┘
```

## Data sources

- **UW's official Schedule of Classes** (classes.uwaterloo.ca) — the
  authoritative source for open seats: eligibility notes ("For CUGW Chinese
  Students only"), reserved-seat sub-pools, waitlist counts. `lib/uwSchedule.js`.
- **UWFlow** (uwflow.com) — crowdsourced ratings only, via `/rating`.
  `lib/uwflowRatings.js`.

## Project layout

```
schema.js                     one table: config (secrets only — see below)
lib/
  uwSchedule.js                fetch + parse the official schedule tool (portable)
  uwflowRatings.js             UWFlow GraphQL ratings client (portable)
  store.js                     Upstash Redis-backed watchlist store (portable)
  config.js                    db-backed secret storage (tgcloud-only)
handlers/
  message.js                   command router: /start /help /add /remove /list /check /rating
  _admin.js                    manual-only: sets config values via `tgcloud run`
scripts/
  check-watchlists.mjs         the hourly sweep, run by GitHub Actions
.github/workflows/hourly-check.yml
```

"Portable" modules have no `sdk` import — they're used both as tgcloud
bare-name imports (`from 'lib/uwSchedule'`) and as plain relative imports
from the GitHub Actions script (`from '../lib/uwSchedule.js'`), so the
parsing/checking logic exists in exactly one place.

## Setup

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the
prompts → you'll get a bot token (looks like `123456:ABC-...`). Keep it.

### 2. Get a Serverless CLI access token

In BotFather: your bot → **Serverless** → **CLI Access** → generates a
token for `tgcloud login` (different from the bot token above).

### 3. Link and deploy this project

```bash
cd ~/Develop/uwflow-tg-bot
npx tgcloud login        # paste the CLI access token from step 2
npx tgcloud push         # deploys schema.js, lib/, handlers/
npx tgcloud migrate      # creates the `config` table (interactive; confirm)
```

### 4. Create a free Upstash Redis database

[upstash.com](https://upstash.com) → create a Redis database (free tier is
plenty for this) → copy the **REST URL** and **REST Token** from its
dashboard.

### 5. Set the bot's secrets (never committed to source)

```bash
npx tgcloud run handlers/_admin '{"key":"UPSTASH_REDIS_REST_URL","value":"https://YOUR-DB.upstash.io"}'
npx tgcloud run handlers/_admin '{"key":"UPSTASH_REDIS_REST_TOKEN","value":"YOUR_TOKEN"}'
```

### 6. Test it

Open your bot in Telegram, send `/start`, then try:
```
/add EARTH 122
/list
/rating SCI 238
```

### 7. Wire up the hourly checker

Push this repo to GitHub (private is fine), then add three **repository
secrets** (Settings → Secrets and variables → Actions):

```bash
gh secret set TELEGRAM_BOT_TOKEN        # the bot token from step 1
gh secret set UPSTASH_REDIS_REST_URL    # same value as step 5
gh secret set UPSTASH_REDIS_REST_TOKEN  # same value as step 5
```

The workflow (`.github/workflows/hourly-check.yml`) runs automatically
every hour. To test it immediately without waiting: Actions tab → "Hourly
watchlist check" → **Run workflow** (or `gh workflow run hourly-check.yml`).

You can also run the checker locally:
```bash
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... TELEGRAM_BOT_TOKEN=... \
  node scripts/check-watchlists.mjs
```

### 8. (Optional) A dedicated high-frequency watch for one section

`scripts/watch-syde522-002.mjs` + `.github/workflows/watch-syde522-002.yml`
poll one specific section (SYDE 522 LEC 002 + its paired TUT 102) every 5
minutes, separate from the general hourly multi-user bot — for exactly this
kind of "I'm already in section 001, DM me the second 002 opens so I can
swap" situation. Needs one more secret:

```bash
gh secret set TELEGRAM_CHAT_ID   # your numeric Telegram user id
```

Get your chat id by messaging [@userinfobot](https://t.me/userinfobot) on
Telegram — it replies instantly with your numeric id.

**Read this before enabling it: GitHub Actions bills in whole-minute
increments per job run, no matter how fast the script actually finishes.**
A 5-minute cron burns through the free tier's 2,000 private-repo
minutes/month in **about a week** of continuous polling. There's no
surprise-bill risk either way — GitHub Free accounts default to a **$0
spending limit**, so the workflow just silently stops firing once the free
minutes run out, rather than charging you. That's the actual failure mode
to plan around: on a private repo, this watch will likely go dark after
about a week unless you either raise the spending limit (small, capped,
known cost) or make the repo **public** (Actions minutes are unlimited and
free for public repos — nothing secret is ever committed to this repo, so
that's the cheaper and more reliable default if you don't mind the code
being visible). The general hourly workflow doesn't have this problem
(~720 runs/month, well inside the free tier).

Once you've caught the seat (or given up), disable the workflow (Actions
tab → the workflow → "..." → Disable workflow) so it stops polling.

## Notes on how it behaves

- **Notifications are edge-triggered**, not repeated every hour a course
  stays open: you're notified when a course goes full→open (or is open the
  moment you `/add` it, shown immediately in the reply). It won't spam you
  hourly while the seat stays open — only on the transition. If it fills
  and reopens later, you'll be notified again.
- **Term is currently hardcoded** to `DEFAULT_TERM_ID` in
  `lib/uwSchedule.js` (Fall 2026 = `1269` as of this writing). Update that
  constant each new term — see the `termId(year, term)` helper in the same
  file. Multi-term support per-user would be a reasonable v2, not built here.
- **15-course watchlist cap per user** (`MAX_WATCHES` in
  `handlers/message.js`) — keeps the hourly sweep's request volume against
  UW's server bounded as usage grows.
- **`/list` and `/check` do a live check**, not a cached read — they're
  slower with a big watchlist (one request per course, 12 max realistically)
  but always accurate.
- A `Notes:` restriction (e.g. partner-program-only sections) is shown with
  every status line but **does not block watching** — the bot can't know
  whether a given user matches a named reserved group, so it surfaces the
  information and lets you judge it, same as the schedule tool itself does.

## Local dev

```bash
npx tgcloud status                    # local vs. deployed diff
npx tgcloud run handlers/message '{"chat":{"id":YOUR_CHAT_ID},"text":"/rating sci 238"}'
node --check lib/*.js handlers/*.js scripts/*.mjs   # quick syntax check
```
