import { spawn } from "node:child_process";
import os from "node:os";
import { analyze } from "./analyze.mjs";
import { isDeniedName, isDir, ReadLog, walk } from "./fsread.mjs";
import { roots as resolveRoots } from "./paths.mjs";
import { loadPrices, priceAgeDays, PRICES_URL, STALE_DAYS } from "./prices.mjs";
import { readClaude } from "./readers/claude.mjs";
import { readCodex } from "./readers/codex.mjs";
import { loadSqlite, readOpenCode } from "./readers/opencode.mjs";
import { flagLines, renderText } from "./render.mjs";
import { compare, historyFile, readLast, saveLast, snapshotOf } from "./history.mjs";
import { renderCheck } from "./render-check.mjs";
import { buildSummary, MAX_DAYS, reportUrl } from "./summary.mjs";
import { VENDORED_FROM } from "./summary-schema.mjs";
import { VERSION } from "./util.mjs";

const TOOLS = ["claude", "codex", "opencode"];

const HELP = `tokenreceipt ${VERSION}: what your AI coding agents would cost at API prices, from local logs.

Usage: npx tokenreceipt [options]
       npx tokenreceipt check [--save] [options]

  check           weekly re-check: compare this run (default last 7 days) with the previous run saved in
                  ~/.tokenreceipt/last.json
  --save          with your consent, save this run's aggregates to ~/.tokenreceipt/last.json (the only file
                  tokenreceipt ever writes; nothing is written without this flag)
  --days N        window in days, 1-${MAX_DAYS} (default 30; 7 for check)
  --tool LIST     comma list of claude,codex,opencode (default all)
  --json          print machine-readable JSON instead of the summary
  --open          build a devprohacks.in report link (summary after '#', never sent to a server) and open it
  --offline       skip the price fetch; use the bundled snapshot
  --dry-run       list the directories that would be read and file counts, then exit
  --paths         list every file read, even when there are many; with --json, include local paths and
                  raw model names (omitted by default so --json output is safer to share)
  -v, --version   print version
  -h, --help      print this help

Reads only:  Claude Code  ~/.claude/projects, ~/.config/claude/projects (or $CLAUDE_CONFIG_DIR/projects)
             Codex        ~/.codex/sessions, ~/.codex/archived_sessions (or $CODEX_HOME)
             OpenCode     ~/.local/share/opencode/opencode.db, .../storage/message (or $OPENCODE_DATA_DIR)
Never reads auth/credential files, config, or .env. Network: one optional GET of ${PRICES_URL}.
`;

export function parseArgs(argv) {
  const o = { command: "report", save: false, days: null, tools: [...TOOLS], json: false, open: false, offline: false, dryRun: false, paths: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (i === 0 && a === "check") {
      o.command = "check";
      continue;
    }
    let val;
    if (a.startsWith("--") && a.includes("=")) [a, val] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    const next = () => {
      if (val !== undefined) return val;
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--days": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
        o.days = n;
        break;
      }
      case "--tool":
      case "--tools": {
        const t = next().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = t.filter((x) => !TOOLS.includes(x));
        if (!t.length || bad.length) throw new Error(`--tool accepts ${TOOLS.join(",")}${bad.length ? ` (got ${bad.join(",")})` : ""}`);
        o.tools = [...new Set(t)];
        break;
      }
      case "--json": o.json = true; break;
      case "--save": o.save = true; break;
      case "--open": o.open = true; break;
      case "--offline": o.offline = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--paths": o.paths = true; break;
      case "-h": case "--help": o.help = true; break;
      case "-v": case "--version": o.version = true; break;
      default:
        throw new Error(a.startsWith("-") ? `unknown option ${a} (see --help)` : `unknown command ${a} (see --help)`);
    }
  }
  if (o.days === null) o.days = o.command === "check" ? 7 : 30;
  if (o.command === "check" && o.open) throw new Error("--open is not available with check");
  return o;
}

async function dryRun(r, tools, out) {
  const L = ["tokenreceipt --dry-run: nothing is opened or parsed; these are the directories and file counts that would be read.", ""];
  const show = async (label, dir, accept, depth) => {
    if (!(await isDir(dir))) return L.push(`  ${label.padEnd(9)}${dir}  (not found)`);
    const n = (await walk(dir, (name, p) => !isDeniedName(p) && accept(name), depth)).length;
    L.push(`  ${label.padEnd(9)}${dir}  (${n} file(s))`);
  };
  if (tools.includes("claude")) for (const d of r.claude.projects) await show("claude", d, (n) => n.endsWith(".jsonl"), 6);
  if (tools.includes("codex")) for (const d of [...r.codex.sessions, ...r.codex.archived]) await show("codex", d, (n) => n.endsWith(".jsonl"), 6);
  if (tools.includes("opencode")) {
    for (const d of r.opencode.dataDirs) await show("opencode", d, (n) => /^opencode(-[\w.-]+)?\.db$/.test(n), 0);
    for (const d of r.opencode.legacy) await show("opencode", d, (n) => /^msg_.*\.json$/.test(n), 2);
  }
  out.write(L.join("\n") + "\n");
}

export function openBrowser(url, env) {
  if (env.TOKENRECEIPT_NO_BROWSER) return false;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** Prices URL may only be overridden to loopback (tests). */
function pricesUrl(env) {
  const u = env.TOKENRECEIPT_PRICES_URL;
  return u && /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(u) ? u : PRICES_URL;
}

export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`tokenreceipt: ${e.message}\n`);
    return 2;
  }
  if (o.help) return out.write(HELP), 0;
  if (o.version) return out.write(VERSION + "\n"), 0;

  const r = resolveRoots(env);
  if (o.dryRun) return await dryRun(r, o.tools, out), 0;

  const nowMs = env.TOKENRECEIPT_NOW ? Date.parse(env.TOKENRECEIPT_NOW) : Date.now();
  const startOfWindow = new Date(nowMs - (o.days - 1) * 86_400_000);
  startOfWindow.setHours(0, 0, 0, 0);
  const opts = { log: new ReadLog(), sinceMs: startOfWindow.getTime(), untilMs: nowMs };
  const pricesP = loadPrices({ offline: o.offline, url: pricesUrl(env), fetchImpl: io.fetch || globalThis.fetch });

  const results = [];
  if (o.tools.includes("claude")) results.push(await readClaude(r, opts));
  if (o.tools.includes("codex")) results.push(await readCodex(r, opts));
  if (o.tools.includes("opencode")) results.push(await readOpenCode(r, { ...opts, sqlite: io.sqlite !== undefined ? io.sqlite : await loadSqlite() }));
  const events = results.flatMap((x) => x.events);
  const statuses = results.map((x) => x.status);
  const prices = await pricesP;
  prices.ageDays = priceAgeDays(prices.asOf, nowMs);
  prices.stale = prices.ageDays !== null && prices.ageDays > STALE_DAYS;
  const a = analyze(events, prices, { days: o.days, nowMs });
  const summary = buildSummary(a, { statuses, log: opts.log });
  const url = o.open || o.json ? reportUrl(summary) : null;
  const snap = snapshotOf(a, nowMs);
  const last = o.command === "check" ? await readLast(env, opts.log) : null;
  const cmp = last && last.snap ? compare(last.snap, snap) : null;
  let saved = null;
  let saveError = null;
  if (o.save) {
    try {
      saved = await saveLast(env, snap);
    } catch (e) {
      saveError = e && e.message ? e.message : String(e);
    }
  }

  if (o.json) {
    const full = o.paths;
    const base = {
      tool: `tokenreceipt/${VERSION}`,
      generatedAt: new Date(nowMs).toISOString(),
      window: { days: a.windowDays, from: a.from, to: a.to, activeDays: a.activeDays },
      prices: { asOf: prices.asOf, source: prices.source, note: prices.note, ageDays: prices.ageDays, stale: prices.stale },
      totals: { ...a.totals, cost: round(a.totals.cost) },
      sessions: a.sessions,
      models: a.models.map((m) => ({ id: m.id, label: m.id || full ? m.label : "(unpriced model)", ...(full ? { rawModels: m.raw } : {}), fuzzy: m.fuzzy, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, requests: m.requests, cost: round(m.cost) })),
      cache: { hitRatio: round(a.cache.hitRatio, 4), writeRatio: round(a.cache.writeRatio, 4), saved: round(a.cache.saved) },
      flags: Object.fromEntries(Object.entries(a.flags).map(([k, v]) => [k, { count: v.count, cost: round(v.cost) }])),
      topFlags: flagLines(a).slice(0, 3).map((x) => ({ flag: x.k, text: x.text, cost: round(x.cost) })),
      daily: a.daily.map((d) => ({ day: d.day, cost: round(d.cost) })),
      ...(full
        ? { unpriced: a.unpriced.map(([model, calls]) => ({ model, calls })) }
        : { unpricedCalls: a.unpriced.reduce((n, [, c]) => n + c, 0) }),
      sources: full ? statuses : statuses.map(({ roots, ...rest }) => ({ ...rest, roots: roots.length })),
      ...(full ? { filesRead: opts.log.files, notRead: opts.log.skipped } : { filesReadCount: opts.log.files.length, notReadCount: opts.log.skipped.length }),
      parseErrors: opts.log.errors,
      history: { file: historyFile(env), saved, saveError },
      paths: full
        ? "included (--paths): this output contains local file paths and raw model names; review before sharing"
        : "omitted: local file paths and raw model names are left out; add --paths to include them",
    };
    const body =
      o.command === "check"
        ? { ...base, command: "check", previous: last.snap || null, previousError: last.error || null, comparison: cmp }
        : { ...base, summary, summarySchema: { source: "feat/v2 src/lib/summary-schema.ts", ...VENDORED_FROM }, reportUrl: url };
    let json = JSON.stringify(body, null, 2);
    if (!full) json = redactHome(json, env);
    out.write(json + "\n");
  } else if (o.command === "check") {
    out.write(renderCheck(a, { cmp, last, saved, saveError, file: historyFile(env), statuses, log: opts.log, prices, showAllPaths: o.paths }));
  } else {
    out.write(renderText(a, { statuses, log: opts.log, prices, showAllPaths: o.paths }));
    if (saved) out.write(`  Saved this run's aggregates to ${saved} (--save).\n`);
  }
  if (saveError) err.write(`tokenreceipt: not saved: ${saveError}\n`);
  if (o.open) {
    if (!url) {
      err.write("\nNo usage in the window, so there is no report link to open.\n");
    } else {
      const opened = openBrowser(url, env);
      (o.json ? err : out).write(`\nReport link (the summary is after '#', which browsers never send to the server):\n${url}\n${opened ? "Opening in your browser…\n" : ""}`);
    }
  }
  return saveError ? 1 : 0;
}

/** Belt and braces for --json without --paths: no string keeps the home directory (e.g. in an error message). */
function redactHome(json, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (!home || home.length < 2) return json;
  const esc = JSON.stringify(home).slice(1, -1); // as it appears inside JSON strings
  return json.split(esc).join("~");
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
