import { costOf, makeMatcher, outputCostOf } from "./prices.mjs";
import { bucketOf, isHuge } from "./summary-schema.mjs";
import { dayKey, percentile } from "./util.mjs";

/** Thresholds are ours, not vendor guidance. Printed next to every flag. */
export const THRESHOLDS = {
  runawayUsd: 20, // session AEC above max($20, P95 of sessions)
  runawayRequests: 150, // or more than 150 calls in one session
  runawayMinSessions: 20, // P95 is used only with at least 20 sessions
  hugeContext: 150_000, // input + cache read + cache write per call (same as the shared schema's isHuge)
  outputHeavyDayMultiple: 2, // day AEC > 2x median day...
  outputHeavyShare: 0.6, // ...and output > 60% of that day's cost
  tinyOutput: 300, // top-tier call that produced < 300 output tokens
  topTierOutputRate: 20, // "top tier" = output price >= $20 per 1M tokens
};

const emptyTot = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 });
const addTok = (a, b) => {
  for (let i = 0; i < 4; i++) a[i] += b[i];
};
const add = (t, e, cost) => {
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  t.requests++;
  t.cost += cost;
};

/**
 * Turn usage events into aggregates. Input events carry only tool, timestamp, model, hashed session and four
 * token counts, so nothing here can leak prompt text.
 */
export function analyze(events, prices, { days, nowMs }) {
  const match = makeMatcher(prices);
  const totals = emptyTot();
  const models = new Map(); // priced id (or "?raw") -> agg
  const sessions = new Map();
  const daysMap = new Map();
  const tools = new Set();
  const unpriced = new Map();
  const flags = {
    runaway: { count: 0, cost: 0 },
    hugeContext: { count: 0, cost: 0 },
    outputHeavyDays: { count: 0, cost: 0 },
    tinyTopTier: { count: 0, cost: 0 },
  };
  let cacheSaved = 0;

  for (const e of events) {
    tools.add(e.tool);
    const hit = match(e.model);
    const row = hit && hit.row;
    const cost = row ? costOf(row, e) : 0;
    add(totals, e, cost);
    const key = row ? row.id : "?" + e.model;
    let m = models.get(key);
    if (!m) models.set(key, (m = { key, id: row ? row.id : null, label: row ? row.label : e.model, raw: new Set(), fuzzy: false, b: {}, huge: { n: 0, t: [0, 0, 0, 0] }, ...emptyTot() }));
    m.raw.add(e.model);
    const t4 = [e.input, e.output, e.cacheRead, e.cacheWrite];
    const bk = bucketOf(t4);
    const bb = m.b[bk] || (m.b[bk] = { n: 0, t: [0, 0, 0, 0] });
    bb.n++;
    addTok(bb.t, t4);
    const huge = isHuge(t4);
    if (huge) {
      m.huge.n++;
      addTok(m.huge.t, t4);
    }
    if (hit && hit.via === "fuzzy") m.fuzzy = true;
    add(m, e, cost);
    if (!row) unpriced.set(e.model, (unpriced.get(e.model) || 0) + 1);

    let s = sessions.get(e.session);
    if (!s) sessions.set(e.session, (s = { cost: 0, requests: 0, start: e.ts, t: [0, 0, 0, 0], maxCtx: 0, byModel: new Map() }));
    s.cost += cost;
    s.requests++;
    if (e.ts < s.start) s.start = e.ts;
    addTok(s.t, t4);
    s.maxCtx = Math.max(s.maxCtx, e.input + e.cacheRead + e.cacheWrite);
    s.byModel.set(key, (s.byModel.get(key) || 0) + e.input + e.output + e.cacheRead + e.cacheWrite);

    const dk = dayKey(e.ts);
    let d = daysMap.get(dk);
    if (!d) daysMap.set(dk, (d = { cost: 0, outCost: 0, requests: 0, byModel: new Map() }));
    d.cost += cost;
    const dm = d.byModel.get(key) || [0, 0, 0, 0];
    addTok(dm, t4);
    d.byModel.set(key, dm);
    d.outCost += row ? outputCostOf(row, e) : 0;
    d.requests++;

    if (row) {
      const cr = row.cacheRead ?? row.input;
      cacheSaved += (e.cacheRead * Math.max(0, row.input - cr)) / 1e6;
      if (huge) {
        flags.hugeContext.count++;
        flags.hugeContext.cost += cost;
      }
      if (row.output >= THRESHOLDS.topTierOutputRate && e.output < THRESHOLDS.tinyOutput) {
        flags.tinyTopTier.count++;
        flags.tinyTopTier.cost += cost;
      }
    }
  }

  const sCosts = [...sessions.values()].map((s) => s.cost).sort((a, b) => a - b);
  // P95 only means something with enough sessions; below runawayMinSessions the line is the flat $20.
  const runawayLine = sCosts.length >= THRESHOLDS.runawayMinSessions ? Math.max(THRESHOLDS.runawayUsd, percentile(sCosts, 95)) : THRESHOLDS.runawayUsd;
  for (const s of sessions.values()) {
    if (s.cost > runawayLine || s.requests > THRESHOLDS.runawayRequests) {
      flags.runaway.count++;
      flags.runaway.cost += s.cost;
    }
  }
  const dCosts = [...daysMap.values()].map((d) => d.cost).sort((a, b) => a - b);
  if (dCosts.length >= 3) {
    const med = percentile(dCosts, 50);
    for (const d of daysMap.values()) {
      if (d.cost > THRESHOLDS.outputHeavyDayMultiple * med && d.cost > 0 && d.outCost / d.cost > THRESHOLDS.outputHeavyShare) {
        flags.outputHeavyDays.count++;
        flags.outputHeavyDays.cost += d.cost;
      }
    }
  }

  // daily series: one entry per calendar day in the window, oldest first, capped to the last 30
  const series = [];
  const n = Math.min(days, 30);
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(nowMs - i * 86_400_000);
    series.push({ day: k, cost: daysMap.get(k)?.cost || 0 });
  }

  const ctx = totals.input + totals.cacheRead + totals.cacheWrite;
  const modelList = [...models.values()]
    .map((m) => ({ ...m, raw: [...m.raw].sort() }))
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  return {
    windowDays: days,
    from: dayKey(nowMs - (days - 1) * 86_400_000),
    to: dayKey(nowMs),
    activeDays: daysMap.size,
    tools: [...tools].sort(),
    totals,
    models: modelList,
    sessions: sessions.size,
    cache: { hitRatio: ctx ? totals.cacheRead / ctx : 0, writeRatio: ctx ? totals.cacheWrite / ctx : 0, saved: cacheSaved },
    flags,
    runawayLine,
    daily: series,
    days: daysMap,
    sessionList: [...sessions.values()],
    unpriced: [...unpriced.entries()].sort((a, b) => b[1] - a[1]),
    pricesAsOf: prices.asOf,
  };
}
