import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeniedName, isDir, readSmallJson, walk } from "../fsread.mjs";
import { clean, hashId, tok } from "../util.mjs";

export const SQLITE_FALLBACK_HINT = "npx ccusage@20 opencode daily --json";

/** node:sqlite ships in Node 22.13+ / 23.4+ (unflagged); on older Node we skip the database with a clear message. */
export async function loadSqlite() {
  try {
    const mod = await import("node:sqlite");
    return mod && mod.DatabaseSync ? mod : null;
  } catch {
    return null;
  }
}

/** Shape shared by legacy msg_*.json files and the JSON `data` column of the SQLite `message` table. */
function toEvent(m, fallbackSession, fallbackId, fallbackTs) {
  if (!m || typeof m !== "object" || m.role !== "assistant") return null;
  const t = m.tokens;
  if (!t || typeof t !== "object") return null;
  const cache = t.cache && typeof t.cache === "object" ? t.cache : {};
  const ts = Number(m.time && m.time.created) || Number(fallbackTs) || NaN;
  const model = typeof m.modelID === "string" ? m.modelID : "";
  if (!model) return null;
  return {
    id: String(m.id || fallbackId || ""),
    tool: "opencode",
    ts: ts < 1e12 ? ts * 1000 : ts, // seconds or ms
    model: typeof m.providerID === "string" && m.providerID ? `${m.providerID}/${model}` : model,
    sessionRaw: String(m.sessionID || fallbackSession || ""),
    input: tok(t.input),
    output: tok(t.output) + tok(t.reasoning),
    cacheRead: tok(cache.read),
    cacheWrite: tok(cache.write),
  };
}

/**
 * OpenCode: <data>/opencode.db (and opencode-*.db), opened READ-ONLY via node:sqlite, plus legacy
 * <data>/storage/message/<session>/msg_*.json. auth.json and everything else in the data dir is never opened.
 * Messages are deduped on message id across both sources (forked sessions copy rows and would double count).
 */
export async function readOpenCode(r, { log, sinceMs, untilMs, sqlite }) {
  const status = { tool: "opencode", roots: [], found: false, files: 0, events: 0, duplicates: 0, badLines: 0, notes: [] };
  const seen = new Set();
  const events = [];
  const push = (e) => {
    if (!e || !Number.isFinite(e.ts) || e.ts < sinceMs || e.ts > untilMs) return;
    if (e.id) {
      if (seen.has(e.id)) {
        status.duplicates++;
        return;
      }
      seen.add(e.id);
    }
    const { id, sessionRaw, ...rest } = e;
    void id;
    events.push({ ...rest, session: hashId("opencode:" + sessionRaw) });
  };

  // 1. SQLite (primary since OpenCode 1.2)
  for (const dir of r.opencode.dataDirs) {
    if (!(await isDir(dir))) continue;
    let names = [];
    try {
      names = (await readdir(dir)).filter((n) => /^opencode(-[\w.-]+)?\.db$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const db = path.join(dir, n);
      if (isDeniedName(db)) continue;
      try {
        if (!(await lstat(db)).isFile()) continue;
      } catch {
        continue;
      }
      status.found = true;
      if (!status.roots.includes(dir)) status.roots.push(dir);
      if (!sqlite) {
        log.skip(db, "node:sqlite unavailable");
        status.notes.push(
          `Skipped ${path.basename(db)}: reading OpenCode's SQLite database needs Node 22.13+ (built-in node:sqlite); you are on Node ${process.versions.node}. ` +
            `Upgrade Node, or use: ${SQLITE_FALLBACK_HINT}`,
        );
        continue;
      }
      status.files++;
      try {
        const st = await lstat(db);
        log.opened(db, dir, st.size);
        readSqlite(sqlite, db, push, status);
      } catch (e) {
        log.errors++;
        status.notes.push(`Could not read ${path.basename(db)}: ${clean(e && e.message ? e.message : e).split(dir).join("<data dir>").slice(0, 160)}`);
      }
    }
  }

  // 2. Legacy JSON storage
  for (const root of r.opencode.legacy) {
    if (!(await isDir(root))) continue;
    status.found = true;
    status.roots.push(root);
    const files = await walk(root, (n) => /^msg_.*\.json$/.test(n), 2);
    for (const f of files) {
      status.files++;
      const m = await readSmallJson(f, log, root);
      if (!m) continue;
      push(toEvent(m, path.basename(path.dirname(f)), path.basename(f, ".json")));
    }
  }
  status.events = events.length;
  return { status, events };
}

function readSqlite(sqlite, file, push, status) {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => String(t.name));
    // `message` is the canonical table; any other *message* table (e.g. session_message forks) is deduped by id.
    const ordered = tables.filter((t) => /message/i.test(t) && !/part/i.test(t)).sort((a, b) => (a === "message" ? -1 : b === "message" ? 1 : a.localeCompare(b)));
    for (const t of ordered) {
      const cols = db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all().map((c) => String(c.name));
      if (!cols.includes("data")) continue;
      const sel = ["data", ...["id", "session_id", "time_created"].filter((c) => cols.includes(c))];
      const q = db.prepare(`SELECT ${sel.map((c) => `"${c}"`).join(",")} FROM "${t.replace(/"/g, '""')}"`);
      for (const row of q.iterate()) {
        let m;
        try {
          m = JSON.parse(String(row.data));
        } catch {
          status.badLines++;
          continue;
        }
        push(toEvent(m, row.session_id, row.id, row.time_created));
      }
    }
  } finally {
    db.close();
  }
}
