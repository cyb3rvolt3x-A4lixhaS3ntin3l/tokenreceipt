import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileNoFollow } from "./fsread.mjs";
import { VERSION } from "./util.mjs";

/**
 * Local history for `tokenreceipt check`. The ONLY place tokenreceipt ever writes is ~/.tokenreceipt/last.json, and
 * only when the user passes --save. The file holds aggregates (token totals, AEC, cache ratio, flag counts, price-table
 * model ids): no paths, session ids, raw model names or text. Symlinked dirs/files are refused.
 */
export const HISTORY_SCHEMA = "tokenreceipt.last/1";
export const historyDir = (env = process.env) => path.join(env.HOME || env.USERPROFILE || os.homedir(), ".tokenreceipt");
export const historyFile = (env) => path.join(historyDir(env), "last.json");

const r2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function snapshotOf(a, nowMs) {
  return {
    schema: HISTORY_SCHEMA,
    tool: `tokenreceipt/${VERSION}`,
    savedAt: new Date(nowMs).toISOString(),
    window: { days: a.windowDays, from: a.from, to: a.to, activeDays: a.activeDays },
    pricesAsOf: a.pricesAsOf,
    tools: a.tools,
    totals: { ...a.totals, cost: r2(a.totals.cost) },
    sessions: a.sessions,
    cacheHit: Math.round(a.cache.hitRatio * 10000) / 10000,
    flags: Object.fromEntries(Object.entries(a.flags).map(([k, v]) => [k, { count: v.count, cost: r2(v.cost) }])),
    models: a.models.filter((m) => m.id).map((m) => ({ id: m.id, requests: m.requests, tokens: m.input + m.output + m.cacheRead + m.cacheWrite, cost: r2(m.cost) })),
  };
}

export function validateSnapshot(o) {
  if (!o || o.schema !== HISTORY_SCHEMA || typeof o.savedAt !== "string" || !Number.isFinite(Date.parse(o.savedAt))) return null;
  const w = o.window;
  if (!w || !isNum(w.days) || !DAY.test(w.from) || !DAY.test(w.to)) return null;
  const t = o.totals;
  if (!t || !["input", "output", "cacheRead", "cacheWrite", "requests", "cost"].every((k) => isNum(t[k]))) return null;
  if (!isNum(o.cacheHit) || o.cacheHit > 1 || !o.flags || typeof o.flags !== "object" || !Array.isArray(o.models)) return null;
  for (const m of o.models) if (!m || typeof m.id !== "string" || !isNum(m.tokens) || !isNum(m.cost) || !isNum(m.requests)) return null;
  return o;
}

async function realDir(dir) {
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory; refusing to use it`);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

/** Read the previous run, if any. Returns { snap } | { none: true } | { error }. Records the read in the ledger. */
export async function readLast(env, log) {
  const file = historyFile(env);
  try {
    if (!(await realDir(historyDir(env)))) return { none: true, file };
    let st;
    try {
      st = await lstat(file);
    } catch (e) {
      if (e && e.code === "ENOENT") return { none: true, file };
      throw e;
    }
    if (st.isSymbolicLink() || !st.isFile()) return { error: `${file} is not a regular file; ignored`, file };
    if (st.size > 1_000_000) return { error: `${file} is too large; ignored`, file };
    if (log) log.opened(file, historyDir(env), st.size);
    const snap = validateSnapshot(JSON.parse(await readFileNoFollow(file)));
    return snap ? { snap, file } : { error: `${file} is not a tokenreceipt history file; ignored`, file };
  } catch (e) {
    return { error: `could not read ${file}: ${e && e.message ? e.message : e}`, file };
  }
}

/** Write ~/.tokenreceipt/last.json atomically (0600, dir 0700). Only called with --save. */
export async function saveLast(env, snap) {
  const dir = historyDir(env);
  if (!(await realDir(dir))) await mkdir(dir, { mode: 0o700 });
  const file = historyFile(env);
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${file} is not a regular file; refusing to overwrite`);
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  const tmp = path.join(dir, `.last.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(snap, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return file;
}

const change = (prev, cur) => ({ prev, cur, delta: cur - prev, ratio: prev > 0 ? (cur - prev) / prev : null });

/** Compare two snapshots. When window lengths differ, totals are compared as per-day averages. */
export function compare(prev, cur) {
  const sameLen = prev.window.days === cur.window.days;
  const pd = sameLen ? 1 : prev.window.days;
  const cd = sameLen ? 1 : cur.window.days;
  const per = (p, c) => change(p / pd, c / cd);
  const tokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
  const flags = {};
  for (const k of new Set([...Object.keys(prev.flags), ...Object.keys(cur.flags)])) flags[k] = change(prev.flags[k]?.count || 0, cur.flags[k]?.count || 0);
  const pm = new Map(prev.models.map((m) => [m.id, m]));
  const cm = new Map(cur.models.map((m) => [m.id, m]));
  const moved = [...new Set([...pm.keys(), ...cm.keys()])]
    .map((id) => ({ id, ...per(pm.get(id)?.cost || 0, cm.get(id)?.cost || 0) }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return {
    basis: sameLen ? "totals" : "per-day averages",
    previous: { savedAt: prev.savedAt, window: prev.window, pricesAsOf: prev.pricesAsOf },
    current: { window: cur.window, pricesAsOf: cur.pricesAsOf },
    cost: per(prev.totals.cost, cur.totals.cost),
    requests: per(prev.totals.requests, cur.totals.requests),
    tokens: per(tokens(prev.totals), tokens(cur.totals)),
    cacheHit: change(prev.cacheHit, cur.cacheHit),
    flags,
    models: {
      new: [...cm.keys()].filter((id) => !pm.has(id)),
      gone: [...pm.keys()].filter((id) => !cm.has(id)),
      biggestMoves: moved.filter((m) => m.delta !== 0).slice(0, 3),
    },
    pricesChanged: prev.pricesAsOf !== cur.pricesAsOf,
  };
}
