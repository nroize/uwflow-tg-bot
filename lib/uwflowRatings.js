// lib/uwflowRatings.js — thin client for UWFlow's public GraphQL API
// (https://uwflow.com/graphql), used only for course ratings/reviews here.
// See ~/Develop/claude-plugins/uwflow-plugin for the fuller reference on
// this API's schema and quirks. Portable like lib/uwSchedule.js — no `sdk`
// import, network calls take an injected `fetchImpl`.

const GRAPHQL_URL = 'https://uwflow.com/graphql';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Origin: 'https://uwflow.com',
  Referer: 'https://uwflow.com/',
};

async function postGraphql(query, variables, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(GRAPHQL_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!res.ok) throw new Error(`uwflow.com HTTP ${res.status}`);
  return res.json();
}

/** code like "earth122" -> "earth122" (lowercase, no space) */
function normalizeCode(subject, catalog) {
  return `${subject}${catalog}`.toLowerCase().replace(/\s+/g, '');
}

export async function getCourseRating(subject, catalog, fetchImpl) {
  const code = normalizeCode(subject, catalog);
  const query = `query($code: String!) {
    course(where: { code: { _eq: $code } }) {
      code name
      rating { easy useful liked comment_count }
    }
  }`;
  const data = await postGraphql(query, { code }, fetchImpl);
  if (data.errors) throw new Error(`UWFlow GraphQL error: ${JSON.stringify(data.errors)}`);
  const course = data.data.course[0];
  return course || null;
}

export function formatRating(course) {
  if (!course) return "No UWFlow entry for that course code — double check the subject/number.";
  const r = course.rating || {};
  const pct = (v) => (v == null ? 'no data' : `${Math.round(v * 100)}%`);
  return [
    `*${course.code.toUpperCase()}* — ${course.name}`,
    `😌 found easy: ${pct(r.easy)}`,
    `👍 found useful: ${pct(r.useful)}`,
    `❤️ liked: ${pct(r.liked)}`,
    r.comment_count ? `(${r.comment_count} reviews)` : '(no reviews yet)',
  ].join('\n');
}
