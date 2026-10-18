import { readFileSync } from "node:fs";
import { clean, CTRL_RE, USER_AGENT } from "./util.mjs";

export const PRICES_URL = "https://devprohacks.in/api/prices";
const BUNDLED = JSON.parse(readFileSync(new URL("../data/prices.json", import.meta.url), "utf8"));

const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10000;
const rate = (v) => v === null || num(v);
export const TABLE_SCHEMA = "tokenreceipt.prices/1";
/** Row kinds the v2 snapshot uses (feat/v2 src/lib/prices/snapshot-types.ts SnapKind). */
export const KINDS = ["vendor", "synced", "single-source", "free-promo", "legacy"];
const ROW_KEYS = ["id", "label", "kind", "input", "output", "cacheRead", "cacheWrite", "aliases", "compare"];

/**
 * Strictly validate a `tokenreceipt.prices/1` table: exactly what GET /api/prices serves (feat/v2
 * src/lib/server/prices-api.ts cliTable) and what data/prices.json bundles. Unknown row keys are dropped;
 * anything malformed throws, and the caller falls back to the bundled copy.
 */
export function validateTable(t) {
  if (!t || typeof t !== "object" || t.schema !== TABLE_SCHEMA) throw new Error("not a tokenreceipt.prices/1 table");
  if (typeof t.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.asOf)) throw new Error("bad asOf");
  if (typeof t.generatedAt !== "string" || !Number.isFinite(Date.parse(t.generatedAt))) throw new Error("bad generatedAt");
  if (!Array.isArray(t.rows) || t.rows.length < 5 || t.rows.length > 2000) throw new Error("bad rows");
  const seen = new Set();
  const rows = t.rows.map((r) => {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(r.id)) throw new Error("bad id");
    if (seen.has(r.id)) throw new Error(`duplicate id ${r.id}`);
    seen.add(r.id);
    if (typeof r.label !== "string" || !r.label || r.label.length > 80 || CTRL_RE.test(r.label)) throw new Error(`bad label for ${r.id}`);
    if (!KINDS.includes(r.kind)) throw new Error(`unknown kind for ${r.id}`);
    if (!num(r.input) || !num(r.output) || !rate(r.cacheRead) || !rate(r.cacheWrite)) throw new Error(`bad rate for ${r.id}`);
    if (!Array.isArray(r.aliases) || r.aliases.length > 64 || !r.aliases.every((a) => typeof a === "string" && a.length <= 96 && !CTRL_RE.test(a))) throw new Error(`bad aliases for ${r.id}`);
    if (typeof r.compare !== "boolean") throw new Error(`bad compare for ${r.id}`);
    return Object.fromEntries(ROW_KEYS.map((k) => [k, k === "aliases" ? r.aliases.map((a) => a.toLowerCase()) : r[k]]));
  });
  return { asOf: t.asOf, generatedAt: t.generatedAt, rows };
}

export function bundledPrices() {
  return { ...validateTable(BUNDLED), source: "bundled" };
}

/**
 * The only network request tokenreceipt makes: GET the public price table. No body, no query string, no cookies,
 * nothing about your usage. 3 s timeout; any failure falls back to the bundled snapshot. Skipped with --offline.
 */
export async function loadPrices({ offline, url = PRICES_URL, timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  const fallback = bundledPrices();
  if (offline) return { ...fallback, note: "offline: using bundled snapshot" };
  if (typeof fetchImpl !== "function") return { ...fallback, note: "fetch unavailable: using bundled snapshot" };
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readCapped(res, MAX_BODY);
    const t = sanityCheck(validateTable(JSON.parse(text)), fallback);
    if (t.asOf < fallback.asOf || (t.asOf === fallback.asOf && Date.parse(t.generatedAt) < Date.parse(fallback.generatedAt)))
      return { ...fallback, note: `online table (${t.asOf}) older than bundled; using bundled snapshot` };
    return { ...t, source: "online", note: `fetched ${url}` };
  } catch (e) {
    // the message can quote the response body (JSON.parse errors do): keep it short and inert
    const why = e && e.name === "TimeoutError" ? "timeout" : clean(e && e.message ? e.message : e).slice(0, 80);
    return { ...fallback, note: `price fetch failed (${why}): using bundled snapshot` };
  }
}

export const MAX_BODY = 1_000_000;

/** Read a response body with a byte cap: refuse a large Content-Length up front, and stop streaming past the cap. */
export async function readCapped(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Error("response too large");
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new Error("response too large");
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * Sanity floor for a fetched table (the bundled copy is the reference):
 *  - a row may be $0/$0 only if it is a free promo or the bundled copy also has it at $0;
 *  - more than 10% zero-priced rows rejects the whole table.
 */
export function sanityCheck(t, bundled) {
  const ref = new Map(bundled.rows.map((r) => [r.id, r]));
  const zero = (r) => r.input === 0 && r.output === 0;
  let zeros = 0;
  for (const r of t.rows) {
    if (!zero(r)) continue;
    zeros++;
    const b = ref.get(r.id);
    if (r.kind !== "free-promo" && !(b && zero(b))) throw new Error(`zero price for ${r.id}`);
  }
  if (zeros > Math.max(2, t.rows.length * 0.1)) throw new Error("too many zero prices");
  return t;
}

/** Days between the table's asOf date and now (UTC days). Over STALE_DAYS the report says so up front. */
export const STALE_DAYS = 7;
export function priceAgeDays(asOf, nowMs) {
  const d = Math.floor((nowMs - Date.parse(asOf + "T00:00:00Z")) / 86_400_000);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}
export const staleLine = (p) =>
  p.ageDays !== null && p.ageDays > STALE_DAYS
    ? `  ! Prices are ${p.ageDays} days old (${p.source} table from ${p.asOf}). Costs may be out of date: ${p.source === "bundled" ? "run without --offline, or update tokenreceipt" : "the price service hasn't updated"}.`
    : null;

// ---- model matching (port of the web app's src/lib/models.ts) ----
const MODE_SUFFIX =
  /-(thinking|reasoning|high|low|medium|minimal|xhigh|max|fast|latest|preview|exp|experimental|instruct|chat|online|beta|nothink|non-thinking|1m|200k)$/;
const GENERIC = new Set(["claude-sonnet", "claude-opus", "claude-haiku", "claude-fable"]);

function candidates(raw) {
  const out = [];
  const push = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };
  let s = raw.trim().toLowerCase().replace(/\s+/g, "-");
  push(s);
  s = s.replace(/^.*\//, "");
  push(s);
  s = s.replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|openai|google|deepseek|z-ai|zai)\./, "");
  s = s.replace(/-v\d+(:\d+)?$/, "").replace(/@.*$/, "").replace(/:.*$/, "");
  s = s.replace(/^cursor-/, "").replace(/^models\//, "");
  push(s);
  for (let i = 0; i < 3; i++) {
    s = s.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, "");
    push(s);
  }
  const dotted = (x) => x.replace(/(\d)-(\d)(?=$|-)/g, "$1.$2");
  for (let i = 0; i < 4; i++) {
    push(dotted(s));
    const next = s.replace(MODE_SUFFIX, "");
    if (next === s) break;
    s = next;
    push(s);
  }
  push(dotted(s));
  const d = dotted(s);
  const m = d.match(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku|fable)(.*)$/);
  if (m) {
    push(`claude-${m[2]}-${m[1]}${m[3]}`);
    push(`claude-${m[1]}-${m[2]}`);
    push(`claude-${m[2]}-${m[1]}`);
  }
  return out;
}

export function makeMatcher(table) {
  const alias = new Map();
  for (const row of table.rows) {
    if (row.kind === "free-promo") continue;
    for (const a of [row.id, ...row.aliases]) if (!alias.has(a.toLowerCase())) alias.set(a.toLowerCase(), row);
  }
  const cache = new Map();
  return (raw) => {
    if (!raw) return null;
    if (cache.has(raw)) return cache.get(raw);
    let hit = null;
    const cands = candidates(raw);
    for (const c of cands) {
      if (GENERIC.has(c)) continue;
      if (alias.get(c)) {
        hit = { row: alias.get(c), via: "exact" };
        break;
      }
    }
    if (!hit)
      for (const c of cands) {
        const fam = c.match(/^(claude-(?:sonnet|opus|haiku|fable))/);
        if (fam && alias.get(fam[1])) {
          hit = { row: alias.get(fam[1]), via: "fuzzy" };
          break;
        }
      }
    cache.set(raw, hit);
    return hit;
  };
}

/** API-equivalent cost in USD. Missing cache rates fall back to the input rate (same rule as the web app). */
export function costOf(row, e) {
  const cr = row.cacheRead ?? row.input;
  const cw = row.cacheWrite ?? row.input;
  return (e.input * row.input + e.output * row.output + e.cacheRead * cr + e.cacheWrite * cw) / 1e6;
}
export const outputCostOf = (row, e) => (e.output * row.output) / 1e6;
