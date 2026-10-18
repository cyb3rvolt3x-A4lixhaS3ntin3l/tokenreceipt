import { THRESHOLDS } from "./analyze.mjs";
import { staleLine } from "./prices.mjs";
import { clean, compact, pct, usd, VERSION } from "./util.mjs";

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + " ".repeat(n - String(s).length));
const lpad = (s, n) => (String(s).length >= n ? String(s) : " ".repeat(n - String(s).length) + String(s));
const int = (n) => n.toLocaleString("en-US");

export function flagLines(a) {
  const f = a.flags;
  const items = [
    { k: "runaway", n: f.runaway.count, cost: f.runaway.cost, text: `${int(f.runaway.count)} runaway session(s): over ${usd(a.runawayLine)} or more than ${THRESHOLDS.runawayRequests} calls` },
    { k: "hugeContext", n: f.hugeContext.count, cost: f.hugeContext.cost, text: `${int(f.hugeContext.count)} call(s) with over ${compact(THRESHOLDS.hugeContext)} tokens of context` },
    { k: "outputHeavyDays", n: f.outputHeavyDays.count, cost: f.outputHeavyDays.cost, text: `${int(f.outputHeavyDays.count)} output-heavy day(s): over ${THRESHOLDS.outputHeavyDayMultiple}x your median day, output over ${THRESHOLDS.outputHeavyShare * 100}% of cost` },
    { k: "tinyTopTier", n: f.tinyTopTier.count, cost: f.tinyTopTier.cost, text: `${int(f.tinyTopTier.count)} top-tier call(s) that produced under ${THRESHOLDS.tinyOutput} output tokens` },
  ];
  return items.filter((x) => x.n > 0).sort((x, y) => y.cost - x.cost);
}

export function renderText(a, ctx) {
  const L = [];
  const t = a.totals;
  L.push(`tokenreceipt ${VERSION} · last ${a.windowDays} days (${a.from} to ${a.to}, ${a.activeDays} active) · prices ${a.pricesAsOf} (${ctx.prices.source})`);
  const stale = staleLine(ctx.prices);
  if (stale) L.push(stale);
  L.push("");
  if (!t.requests) {
    L.push("No usage found in the window.");
  } else {
    L.push(`  API-equivalent cost  ${usd(t.cost)}   (what these tokens would cost at list API prices; not your bill)`);
    L.push(`  Calls                ${int(t.requests)} across ${int(a.sessions)} session(s)`);
    L.push(`  Tokens               input ${compact(t.input)} · output ${compact(t.output)} · cache read ${compact(t.cacheRead)} · cache write ${compact(t.cacheWrite)}`);
    L.push(`  Cache hit ratio      ${pct(a.cache.hitRatio)} of input context came from cache (saved about ${usd(a.cache.saved)})`);
    L.push("");
    L.push(`  ${pad("Model", 34)}${lpad("calls", 9)}${lpad("tokens", 10)}${lpad("cost", 11)}${lpad("share", 8)}`);
    for (const m of a.models.slice(0, 10)) {
      const tokens = m.input + m.output + m.cacheRead + m.cacheWrite;
      const name = clean(m.id ? m.label.slice(0, 31) : `${m.label.slice(0, 20)} (unpriced)`) + (m.fuzzy ? " ~" : "");
      L.push(`  ${pad(name, 34)}${lpad(int(m.requests), 9)}${lpad(compact(tokens), 10)}${lpad(usd(m.cost), 11)}${lpad(t.cost ? pct(m.cost / t.cost) : "-", 8)}`);
    }
    if (a.models.length > 10) L.push(`  … ${a.models.length - 10} more model(s) in --json`);
    if (a.models.some((m) => m.fuzzy)) L.push("  ~ matched by model family only");
    L.push("");
    const flags = flagLines(a);
    L.push("  Top waste flags (thresholds are ours, not vendor guidance)");
    if (!flags.length) L.push("    none tripped");
    flags.slice(0, 3).forEach((x, i) => L.push(`    ${i + 1}. ${x.text} (${usd(x.cost)})`));
    if (a.windowDays < 7 || a.activeDays < 3) L.push("    Low confidence: fewer than 7 days or 3 active days of data.");
  }
  L.push("");
  L.push("  Sources");
  for (const s of ctx.statuses) {
    if (!s.found) {
      L.push(`    ${pad(s.tool, 9)}not found`);
      continue;
    }
    const dup = s.duplicates ? `, ${int(s.duplicates)} duplicate(s) skipped` : "";
    L.push(`    ${pad(s.tool, 9)}${int(s.files)} file(s), ${int(s.events)} call(s)${dup}`);
    for (const n of s.notes) L.push(`             note: ${clean(n)}`);
  }
  if (a.unpriced.length) L.push(`    unpriced models (no list price yet): ${a.unpriced.slice(0, 5).map(([k, n]) => `${clean(k)} ×${n}`).join(", ")}`);
  L.push("");
  L.push(...renderPaths(ctx.log, ctx.showAllPaths));
  L.push("");
  L.push(`  Read-only. Nothing about your usage left this machine. Prices: ${ctx.prices.note}.`);
  return L.join("\n") + "\n";
}

export function renderPaths(log, all) {
  const L = [];
  const n = log.files.length;
  if (all || n <= 40) {
    L.push(`  Files read (${n}):`);
    for (const f of log.files) L.push(`    ${clean(f)}`);
  } else {
    L.push(`  Files read (${n}) in these directories (run with --paths for the full list):`);
    for (const [d, v] of log.dirs) L.push(`    ${clean(d)}  (${v.files} file(s))`);
  }
  for (const s of log.skipped) L.push(`  Not read: ${clean(s.path)} (${s.reason})`);
  if (log.errors) L.push(`  ${log.errors} file(s) could not be parsed and were skipped.`);
  return L;
}
