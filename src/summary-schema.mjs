// GENERATED, do not edit. Vendored copy of the canonical web schema:
//   feat/v2 @ 5d3087a  src/lib/summary-schema.ts  sha256=06436fe94c80524600f55a3be8b5e0b1ac8f40490c6f74e0cd0ea0e60c117b24
// Regenerate with: node cli/scripts/vendor-schema.mjs <ref>   (types stripped by esbuild, logic unchanged)
// Spec: docs/summary-schema.md on feat/v2.
export const VENDORED_FROM = { commit: "5d3087a", sha256: "06436fe94c80524600f55a3be8b5e0b1ac8f40490c6f74e0cd0ea0e60c117b24" };
const SUMMARY_VERSION = 2;
const FRAGMENT_PREFIX = "v2.";
const MAX_ENCODED_CHARS = 64e3;
const TOOL_IDS = ["claude-code", "codex", "opencode", "cursor", "ccusage", "anthropic-csv", "openai-csv", "manual", "other"];
const BUCKETS = { xsOutput: 300, lightOutput: 1500, lightFresh: 8e3, heavyOutput: 6e3, heavyContext: 12e4, hugeContext: 15e4 };
function bucketOf(t) {
  const [input, output, cacheRead, cacheWrite] = t;
  const context = input + cacheRead + cacheWrite;
  const fresh = input + cacheWrite;
  if (output > BUCKETS.heavyOutput || context > BUCKETS.heavyContext) return "heavy";
  if (output < BUCKETS.xsOutput) return "xs";
  if (output < BUCKETS.lightOutput && fresh < BUCKETS.lightFresh) return "light";
  return "medium";
}
const isHuge = (t) => t[0] + t[2] + t[3] > BUCKETS.hugeContext;
const WARN_CODES = [
  "retention-30d",
  "codex-zst-skipped",
  "opencode-sqlite-unavailable",
  "no-token-data",
  "unmapped-models",
  "partial-window",
  "cursor-included-rows",
  "codex-model-fallback",
  "fuzzy-model-match",
  "parse-errors"
];
const OTHER_ID = "other";
const MAX_MODELS = 12;
const MAX_DAYS = 92;
const MAX_TOP_SESSIONS = 25;
const MAX_TOKENS = 1e13;
const MAX_COUNT = 1e9;
const ID_RE = /^[a-z0-9][a-z0-9.\-]{0,47}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GEN_RE = /^[a-z0-9./\-]{1,32}$/;
const int = (v, max) => {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
};
const tok = (v) => {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const out = v.map((x) => int(x, MAX_TOKENS));
  return out.every((x) => x !== null) ? out : null;
};
const tokReq = (v) => {
  if (!v || typeof v !== "object") return void 0;
  const o = v;
  const n = int(o.n, MAX_COUNT);
  const t = tok(o.t);
  return n !== null && t ? { n, t } : void 0;
};
const dayDiff = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
function validateSummary(x) {
  if (!x || typeof x !== "object") return null;
  const o = x;
  if (o.v !== SUMMARY_VERSION) return null;
  if (o.src !== "cli" && o.src !== "web") return null;
  if (typeof o.gen !== "string" || !GEN_RE.test(o.gen)) return null;
  const w = o.win;
  if (!w || typeof w.from !== "string" || typeof w.to !== "string" || !DATE_RE.test(w.from) || !DATE_RE.test(w.to)) return null;
  const span = dayDiff(w.from, w.to) + 1;
  if (!Number.isFinite(span) || span < 1 || span > MAX_DAYS) return null;
  const activeDays = int(w.activeDays, span) ?? 0;
  if (!Array.isArray(o.tools)) return null;
  const tools = [...new Set(o.tools.filter((t) => typeof t === "string" && TOOL_IDS.includes(t)))];
  if (!Array.isArray(o.models) || o.models.length === 0 || o.models.length > MAX_MODELS) return null;
  const models = [];
  for (const mv of o.models) {
    if (!mv || typeof mv !== "object") return null;
    const m = mv;
    const id = m.id === null ? null : typeof m.id === "string" && ID_RE.test(m.id) ? m.id : void 0;
    if (id === void 0) return null;
    const t = tok(m.tok);
    if (!t) return null;
    const agg = { id, tok: t };
    const req = int(m.req, MAX_COUNT);
    if (req !== null) agg.req = req;
    if (m.b && typeof m.b === "object") {
      const b = {};
      for (const k of ["xs", "light", "medium", "heavy"]) {
        const tr = tokReq(m.b[k]);
        if (tr) b[k] = tr;
      }
      agg.b = b;
    }
    const huge = tokReq(m.huge);
    if (huge) agg.huge = huge;
    models.push(agg);
  }
  const daily = [];
  if (!Array.isArray(o.daily) || o.daily.length > MAX_DAYS * MAX_MODELS) return null;
  for (const r of o.daily) {
    if (!Array.isArray(r) || r.length !== 6) return null;
    const d = int(r[0], span - 1);
    const mi = int(r[1], models.length - 1);
    const t = tok(r.slice(2));
    if (d === null || mi === null || !t || r[0] > span - 1 || r[1] > models.length - 1) return null;
    daily.push([d, mi, ...t]);
  }
  const out = { v: SUMMARY_VERSION, src: o.src, gen: o.gen, win: { from: w.from, to: w.to, days: span, activeDays }, tools, models, daily };
  if (typeof o.snap === "string" && DATE_RE.test(o.snap)) out.snap = o.snap;
  if (o.sessions && typeof o.sessions === "object") {
    const s = o.sessions;
    const n = int(s.n, MAX_COUNT);
    const top = [];
    if (Array.isArray(s.top)) {
      for (const sv of s.top.slice(0, MAX_TOP_SESSIONS)) {
        const so = sv;
        const d = typeof so?.d === "number" && so.d < 0 ? 0 : int(so?.d, span - 1);
        const mi = int(so?.m, models.length - 1);
        const req = int(so?.req, MAX_COUNT);
        const t = tok(so?.t);
        const maxCtx = int(so?.maxCtx, MAX_TOKENS);
        if (d === null || mi === null || req === null || !t || maxCtx === null) continue;
        top.push({ d, m: mi, req, t, maxCtx });
      }
    }
    if (n !== null) out.sessions = { n: Math.max(n, top.length), top };
  }
  const lh = int(o.limitHits, MAX_COUNT);
  if (lh !== null) out.limitHits = lh;
  if (o.q && typeof o.q === "object") {
    const q = o.q;
    const files = int(q.files, MAX_COUNT);
    const skipped = int(q.skipped, MAX_COUNT);
    const warn = Array.isArray(q.warn) ? [...new Set(q.warn.filter((c) => typeof c === "string" && WARN_CODES.includes(c)))] : void 0;
    out.q = { ...files !== null ? { files } : {}, ...skipped !== null ? { skipped } : {}, ...warn?.length ? { warn } : {} };
  }
  return out;
}
function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function encodeSummary(s) {
  const valid = validateSummary(s);
  if (!valid) throw new Error("invalid summary");
  const enc = b64urlEncode(JSON.stringify(valid));
  if (enc.length > MAX_ENCODED_CHARS) throw new Error("summary too large");
  return FRAGMENT_PREFIX + enc;
}
function encodeSummaryFit(s) {
  let cur = validateSummary(s);
  if (!cur) throw new Error("invalid summary");
  const tryEnc = (x) => {
    const enc = b64urlEncode(JSON.stringify(x));
    return enc.length <= MAX_ENCODED_CHARS ? FRAGMENT_PREFIX + enc : null;
  };
  let out = tryEnc(cur);
  while (!out && cur.sessions && cur.sessions.top.length) {
    cur = { ...cur, sessions: { n: cur.sessions.n, top: cur.sessions.top.slice(0, Math.floor(cur.sessions.top.length / 2)) } };
    out = tryEnc(cur);
  }
  if (!out && cur.sessions) {
    const { sessions: _drop, ...rest } = cur;
    void _drop;
    cur = rest;
    out = tryEnc(cur);
  }
  while (!out && cur.daily.length) {
    const first = Math.min(...cur.daily.map((r) => r[0]));
    const warn = [.../* @__PURE__ */ new Set([...cur.q?.warn ?? [], "partial-window"])];
    cur = { ...cur, daily: cur.daily.filter((r) => r[0] !== first), q: { ...cur.q, warn } };
    out = tryEnc(cur);
  }
  if (!out) throw new Error("summary too large");
  return out;
}
function decodeSummary(fragment) {
  if (!fragment) return null;
  const f = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!f.startsWith(FRAGMENT_PREFIX)) return null;
  const body = f.slice(FRAGMENT_PREFIX.length);
  if (!body || body.length > MAX_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  try {
    return validateSummary(JSON.parse(b64urlDecode(body)));
  } catch {
    return null;
  }
}
const REPORT_URL = "https://devprohacks.in/report";
const reportUrl = (s) => `${REPORT_URL}#${encodeSummaryFit(s)}`;
export {
  BUCKETS,
  FRAGMENT_PREFIX,
  MAX_DAYS,
  MAX_ENCODED_CHARS,
  MAX_MODELS,
  MAX_TOP_SESSIONS,
  OTHER_ID,
  REPORT_URL,
  SUMMARY_VERSION,
  TOOL_IDS,
  WARN_CODES,
  bucketOf,
  decodeSummary,
  encodeSummary,
  encodeSummaryFit,
  isHuge,
  reportUrl,
  validateSummary
};
