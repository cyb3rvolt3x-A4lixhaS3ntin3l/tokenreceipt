import { flagLines, renderPaths } from "./render.mjs";
import { staleLine } from "./prices.mjs";
import { clean, compact, pct, usd, VERSION } from "./util.mjs";

const sign = (n, f) => (n > 0 ? "+" : n < 0 ? "−" : "±") + f(Math.abs(n));
const rel = (c) => (c.ratio === null ? (c.cur > 0 ? "new" : "no change") : c.delta === 0 ? "no change" : sign(c.ratio, (r) => `${Math.round(r * 100)}%`));
const FLAG_NAMES = { runaway: "runaway sessions", hugeContext: "huge-context calls", outputHeavyDays: "output-heavy days", tinyTopTier: "top-tier tiny calls" };

export function renderCheck(a, ctx) {
  const L = [];
  const { cmp, last } = ctx;
  L.push(`tokenreceipt ${VERSION} check · last ${a.windowDays} days (${a.from} to ${a.to}) · prices ${a.pricesAsOf} (${ctx.prices.source})`);
  const stale = staleLine(ctx.prices);
  if (stale) L.push(stale);
  L.push("");
  if (!cmp) {
    L.push(last && last.error ? `  Previous run: ${last.error}.` : `  No previous run saved at ${ctx.file}.`);
    L.push(`  This run: ${usd(a.totals.cost)} API-equivalent, ${a.totals.requests.toLocaleString("en-US")} calls, cache hit ${pct(a.cache.hitRatio)}.`);
    const f = flagLines(a);
    if (f.length) L.push(`  Top flag: ${f[0].text} (${usd(f[0].cost)})`);
  } else {
    const p = cmp.previous;
    L.push(`  Compared with the run saved ${p.savedAt.slice(0, 10)} (${p.window.from} to ${p.window.to}, ${p.window.days} days)${cmp.basis === "totals" ? "" : ", as per-day averages because the windows differ"}`);
    L.push("");
    const money = cmp.basis === "totals" ? usd : (n) => `${usd(n)}/day`;
    const count = cmp.basis === "totals" ? (n) => compact(n) : (n) => `${compact(n)}/day`;
    L.push(`  API-equivalent cost  ${money(cmp.cost.prev)} → ${money(cmp.cost.cur)}  (${rel(cmp.cost)})`);
    L.push(`  Calls                ${count(cmp.requests.prev)} → ${count(cmp.requests.cur)}  (${rel(cmp.requests)})`);
    L.push(`  Tokens               ${count(cmp.tokens.prev)} → ${count(cmp.tokens.cur)}  (${rel(cmp.tokens)})`);
    const pts = (Math.round(cmp.cacheHit.cur * 1000) - Math.round(cmp.cacheHit.prev * 1000)) / 10; // same rounding as the shown %
    L.push(`  Cache hit ratio      ${pct(cmp.cacheHit.prev)} → ${pct(cmp.cacheHit.cur)}  (${pts === 0 ? "no change" : `${pts > 0 ? "+" : "−"}${Math.abs(pts)} pts`})`);
    const fl = Object.entries(cmp.flags).filter(([, c]) => c.prev || c.cur);
    L.push(`  Waste flags          ${fl.length ? fl.map(([k, c]) => `${FLAG_NAMES[k] || k} ${c.prev}→${c.cur}`).join(", ") : "none, before or now"}`);
    if (cmp.models.new.length) L.push(`  New models           ${clean(cmp.models.new.join(", "))}`);
    if (cmp.models.gone.length) L.push(`  Not used this time   ${clean(cmp.models.gone.join(", "))}`);
    if (cmp.models.biggestMoves.length) L.push(`  Biggest cost moves   ${cmp.models.biggestMoves.map((m) => `${clean(m.id)} ${sign(m.delta, money)}`).join(", ")}`);
    if (cmp.pricesChanged) L.push(`  Note: prices changed between runs (${p.pricesAsOf} → ${cmp.current.pricesAsOf}); part of any cost change is repricing.`);
  }
  L.push("");
  if (ctx.saved) L.push(`  Saved this run to ${ctx.saved} for next week's check.`);
  else if (ctx.saveError) L.push(`  Not saved: ${ctx.saveError}`);
  else L.push(`  Not saved. Run \`npx tokenreceipt check --save\` to store this run's aggregates in ${ctx.file} (the only file tokenreceipt writes).`);
  L.push("");
  L.push(...renderPaths(ctx.log, ctx.showAllPaths));
  L.push("");
  L.push(`  Read-only unless --save. Nothing about your usage left this machine. Prices: ${ctx.prices.note}.`);
  return L.join("\n") + "\n";
}
