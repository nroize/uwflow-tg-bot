// lib/uwSchedule.js — fetch + parse UW's official (non-Quest) Undergraduate
// Schedule of Classes (classes.uwaterloo.ca / salook.pl). This is the
// authoritative source for whether a seat is actually gettable: it carries
// course-level eligibility Notes (e.g. "For CUGW Chinese Students only")
// and per-section Reserve pools that UWFlow's own API does not expose at
// all. See README.md for the full story of why this exists.
//
// Deliberately dependency-free (no `import ... from 'sdk'`) so the exact
// same file works both as a tgcloud bare-name import (`from 'lib/uwSchedule'`)
// and as a plain relative import from the GitHub Actions checker script
// (`from '../lib/uwSchedule.js'`). Every network call takes an injected
// `fetchImpl` — tgcloud handlers pass the sandbox's `fetch` (from 'sdk');
// the checker script passes Node's global `fetch` (Node >=18).

const ENDPOINT = 'https://classes.uwaterloo.ca/cgi-bin/cgiwrap/infocour/salook.pl';

const MONTH_INT = { winter: 1, spring: 5, fall: 9 };

export function termId(year, term) {
  const m = MONTH_INT[term.toLowerCase()];
  if (!m) throw new Error(`term must be one of ${Object.keys(MONTH_INT)}, got ${term}`);
  return (year - 1900) * 10 + m;
}

// Change this each new term. (2026-08-25: Fall 2026.)
export const DEFAULT_TERM_ID = termId(2026, 'fall'); // 1269

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent] ?? m;
  });
}

function clean(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

export async function fetchScheduleHtml(subject, cournum, term, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams({
    level: 'under',
    sess: String(term),
    subject: subject.toUpperCase(),
    cournum: cournum ?? '',
  }).toString();
  const res = await f(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    body,
  });
  if (!res.ok) throw new Error(`salook.pl HTTP ${res.status}`);
  return res.text();
}

const TD_RE = /<TD[^>]*>([\s\S]*?)<\/TD>/gi;
const ROW_RE = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;

/**
 * Parse salook.pl results HTML into course objects. See the module's
 * companion Python implementation (uwflow-plugin/skills/uwflow/scripts/
 * uw_calendar_query.py) for the same logic with more extensive comments —
 * the two were built and verified together against live samples
 * (2026-08-25). Key facts that make this work:
 *   - Rows are classified by cell count/content, not DOM nesting. Non-greedy
 *     <TR>...</TR> matching naturally flattens the one nested <TABLE> per
 *     course; the only casualty is the inner 13-column TH header row, which
 *     merges with the outer wrapper row into a match with zero <TD> cells
 *     (harmless — matches nothing below).
 *   - A real section row has 12 <TD> cells, not 13: the trailing Instructor
 *     column has no <TD> at all when empty (matches the page's own note
 *     that instructor info "is no longer housed here").
 *   - A `Reserve:` sub-row (7 cells) always follows the section row it
 *     describes.
 *   - A 12-cell row with a blank first cell is a continuation row (another
 *     meeting pattern) for the current section, not a new one.
 */
export function parseScheduleHtml(html) {
  const rows = [];
  let m;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(html)) !== null) rows.push(m[1]);

  const courses = [];
  let currentCourse = null;
  let currentSection = null;

  for (const rowHtml of rows) {
    const cells = [];
    let tm;
    TD_RE.lastIndex = 0;
    while ((tm = TD_RE.exec(rowHtml)) !== null) cells.push(clean(tm[1]));
    if (cells.length === 0) continue;

    if (cells.length === 1 && cells[0].startsWith('Notes:')) {
      if (currentCourse) currentCourse.notes = cells[0].slice('Notes:'.length).trim();
      continue;
    }

    if (cells.length === 4 && /^[A-Z]+$/.test(cells[0])) {
      currentCourse = {
        subject: cells[0], catalog: cells[1], units: cells[2], title: cells[3],
        notes: null, sections: [],
      };
      courses.push(currentCourse);
      currentSection = null;
      continue;
    }

    if (cells.length === 7 && cells[0].startsWith('Reserve:')) {
      if (currentSection) {
        currentSection.reserves.push({
          label: cells[0].slice('Reserve:'.length).trim(),
          cap: cells[1], total: cells[2],
        });
        // The Reserve row's trailing two columns are the SAME Time
        // Days/Date + Bldg Room slots as a normal section row (the
        // colspan=6 label just collapses the first 6 columns). When a
        // section meets more than once a week, one of its extra meeting
        // patterns can show up here instead of a plain continuation row --
        // confirmed live for SYDE522 (cross-listed "Held With: BME 522"),
        // whose LEC actually meets Mon 11:00-12:50 AND Wed 11:00-11:50, but
        // the Monday meeting was only ever present in this row and got
        // silently dropped before this fix. Always check it.
        if (cells[5]) currentSection.meetings.push({ timeDaysDate: cells[5], room: cells[6] });
      }
      continue;
    }

    if (cells.length === 12) {
      const classNum = cells[0];
      if (classNum) {
        currentSection = {
          classNum, sectionName: cells[1], location: cells[2], assocClass: cells[3],
          enrlCap: parseInt(cells[6], 10) || 0, enrlTotal: parseInt(cells[7], 10) || 0,
          waitCap: parseInt(cells[8], 10) || 0, waitTotal: parseInt(cells[9], 10) || 0,
          reserves: [], meetings: [],
        };
        if (cells[10]) currentSection.meetings.push({ timeDaysDate: cells[10], room: cells[11] });
        if (currentCourse) currentCourse.sections.push(currentSection);
      } else if (currentSection && cells[10]) {
        currentSection.meetings.push({ timeDaysDate: cells[10], room: cells[11] });
      }
      continue;
    }
  }

  return courses;
}

export async function checkCourse(subject, cournum, term, fetchImpl) {
  const html = await fetchScheduleHtml(subject, cournum, term, fetchImpl);
  return parseScheduleHtml(html);
}

export function sectionOpen(section) {
  return section.enrlCap > section.enrlTotal;
}

export function anySectionOpen(course) {
  return course.sections.some(sectionOpen);
}

export function formatCourseStatus(course) {
  const lines = [`*${course.subject} ${course.catalog}* — ${course.title}`];
  if (course.notes) lines.push(`⚠️ _${course.notes}_`);
  if (course.sections.length === 0) {
    lines.push('(not offered this term)');
    return lines.join('\n');
  }
  for (const s of course.sections) {
    const open = sectionOpen(s);
    const seats = open ? `${s.enrlCap - s.enrlTotal} open of ${s.enrlCap}` : `FULL (${s.enrlTotal}/${s.enrlCap})`;
    const emoji = open ? '🟢' : '🔴';
    lines.push(`${emoji} ${s.sectionName} — ${seats} — ${s.location}`);
    for (const r of s.reserves) {
      lines.push(`   ↳ reserve "${r.label}": ${r.total}/${r.cap}`);
    }
  }
  return lines.join('\n');
}
