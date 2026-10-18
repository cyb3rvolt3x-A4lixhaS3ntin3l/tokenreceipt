import { encodeSummaryFit, MAX_DAYS, MAX_MODELS, MAX_TOP_SESSIONS, OTHER_ID, REPORT_URL, SUMMARY_VERSION } from "./summary-schema.mjs";
import { dayKey, USER_AGENT } from "./util.mjs";

/**
 * Build the shared v2 UsageSummary (canonical: feat/v2 src/lib/summary-schema.ts, vendored as summary-schema.mjs).
 * Aggregates only: our price-table ids, token counts, request counts, day offsets. No costs, paths, session ids,
 * raw model strings or text. The vendored encoder validates before encoding, so a bad object can never be emitted.
 */
export { REPORT_URL, MAX_DAYS };
export const TOOL_MAP = { claude: "claude-code", codex: "codex", opencode: "opencode" };

const tsum = (t) => t[0] + t[1] + t[2] + t[3];
const addTok = (a, b) => {
  for (let i = 0; i < 4; i++) a[i] += b[i];
};
const tokOf = (m) => [m.input, m.output, m.cacheRead, m.cacheWrite];
const offset = (from, day) => Math.round((Date.parse(day + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);

export function buildSummary(a, { statuses = [], log } = {}) {
  // models: mapped ids largest first (by tokens). Mapped models past the 12 slots merge into OTHER_ID ("other");
  // unmapped models merge into {id: null}. Both merged entries take one slot each.
  const mapped = a.models.filter((m) => m.id).sort((x, y) => tsum(tokOf(y)) - tsum(tokOf(x)) || y.requests - x.requests);
  const unmapped = a.models.filter((m) => !m.id);
  const nullSlot = unmapped.length ? 1 : 0;
  const keepN = mapped.length + nullSlot > MAX_MODELS ? MAX_MODELS - 1 - nullSlot : mapped.length;
  const keep = mapped.slice(0, keepN);
  const overflow = mapped.slice(keepN);
  const index = new Map();
  const models = keep.map((m, i) => {
    index.set(m.key, i);
    return modelAgg(m.id, [m]);
  });
  for (const [id, list] of [[OTHER_ID, overflow], [null, unmapped]]) {
    if (!list.length) continue;
    for (const m of list) index.set(m.key, models.length);
    models.push(modelAgg(id, list));
  }

  // daily: [dayOffset, modelIndex, input, output, cacheRead, cacheWrite]
  const rows = new Map();
  for (const [day, d] of a.days) {
    const off = offset(a.from, day);
    if (off < 0 || off > a.windowDays - 1) continue;
    for (const [key, t] of d.byModel) {
      const k = `${off}:${index.get(key)}`;
      const r = rows.get(k) || [off, index.get(key), 0, 0, 0, 0];
      for (let i = 0; i < 4; i++) r[2 + i] += t[i];
      rows.set(k, r);
    }
  }
  const daily = [...rows.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // sessions: count + top 25 by total tokens. No ids.
  const top = a.sessionList
    .map((s) => {
      let best = null;
      let bestTok = -1;
      for (const [key, n] of s.byModel) if (n > bestTok) [best, bestTok] = [key, n];
      return { d: Math.max(0, offset(a.from, dayKey(s.start))), m: index.get(best), req: s.requests, t: s.t.slice(), maxCtx: s.maxCtx };
    })
    .sort((x, y) => tsum(y.t) - tsum(x.t))
    .slice(0, MAX_TOP_SESSIONS);

  const warn = [];
  const st = (tool) => statuses.find((s) => s.tool === tool);
  if (st("claude")?.found) warn.push("retention-30d");
  if (st("codex")?.zstSkipped) warn.push("codex-zst-skipped");
  if (log && log.skipped.some((x) => x.reason === "node:sqlite unavailable")) warn.push("opencode-sqlite-unavailable");
  if (statuses.some((s) => s.found && s.files > 0 && s.events === 0)) warn.push("no-token-data");
  if (unmapped.length) warn.push("unmapped-models");
  if (a.totals.requests && a.days.size && [...a.days.keys()].sort()[0] > a.from) warn.push("partial-window");
  if (st("codex")?.modelFallback) warn.push("codex-model-fallback");
  if (a.models.some((m) => m.fuzzy)) warn.push("fuzzy-model-match");
  const badLines = statuses.reduce((n, s) => n + (s.badLines || 0), 0);
  if (badLines || (log && log.errors)) warn.push("parse-errors");

  const s = {
    v: SUMMARY_VERSION,
    src: "cli",
    gen: USER_AGENT,
    snap: a.pricesAsOf,
    win: { from: a.from, to: a.to, days: a.windowDays, activeDays: a.activeDays },
    tools: [...new Set(a.tools.map((t) => TOOL_MAP[t]).filter(Boolean))],
    models,
    daily,
    sessions: { n: a.sessions, top },
    q: {
      files: log ? log.files.length : 0,
      skipped: (log ? log.skipped.length + log.errors : 0) + badLines,
      ...(warn.length ? { warn } : {}),
    },
  };
  return s;
}

function modelAgg(id, list) {
  const tok = [0, 0, 0, 0];
  let req = 0;
  const b = {};
  const huge = { n: 0, t: [0, 0, 0, 0] };
  for (const m of list) {
    addTok(tok, tokOf(m));
    req += m.requests;
    for (const [k, v] of Object.entries(m.b)) {
      const x = b[k] || (b[k] = { n: 0, t: [0, 0, 0, 0] });
      x.n += v.n;
      addTok(x.t, v.t);
    }
    huge.n += m.huge.n;
    addTok(huge.t, m.huge.t);
  }
  const out = { id, tok, req, b };
  if (huge.n) out.huge = huge;
  return out;
}

/**
 * Encode with the shared encodeSummaryFit() (it sheds sessions, then oldest days, in the order both producers
 * use). The schema requires at least one model, so an empty run has no link.
 */
export const encodeForLink = (s) => (s.models.length ? encodeSummaryFit(s) : null);

export const reportUrl = (s) => {
  const f = encodeForLink(s);
  return f ? `${REPORT_URL}#${f}` : null;
};
