import path from "node:path";
import { isDeniedName, isDir, readLines, walk } from "../fsread.mjs";
import { hashId, tok } from "../util.mjs";

const FALLBACK_MODEL = "gpt-5";

/**
 * Codex CLI: sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions/). Each `event_msg` with payload.type
 * "token_count" is one model call; we use info.last_token_usage, or the delta of total_token_usage when "last" is
 * missing. Codex reports input_tokens INCLUDING cached_input_tokens, so uncached input = input - cached.
 * Model comes from the latest turn_context. Compressed .jsonl.zst files are skipped and counted.
 */
export async function readCodex(r, { log, sinceMs, untilMs }) {
  const status = { tool: "codex", roots: [], found: false, files: 0, events: 0, duplicates: 0, badLines: 0, notes: [] };
  const events = [];
  let zst = 0;
  let fallbackModel = 0;
  const seenNames = new Set();
  const groups = [...r.codex.sessions, ...r.codex.archived]; // active first: it wins on duplicates
  for (const root of groups) {
    if (!(await isDir(root))) continue;
    status.found = true;
    status.roots.push(root);
    const files = await walk(root, (n) => {
      if (n.endsWith(".jsonl.zst")) zst++;
      return n.endsWith(".jsonl");
    }, 6);
    for (const f of files) {
      const name = path.basename(f);
      if (isDeniedName(f)) {
        log.skip(f, "credential-like name, never read");
        continue;
      }
      if (seenNames.has(name)) {
        // same rollout present in both sessions/ and archived_sessions/: active copy wins
        status.duplicates++;
        continue;
      }
      seenNames.add(name);
      status.files++;
      let model = "";
      let session = name;
      let prevTotal = null;
      try {
        for await (const line of readLines(f, log, root)) {
          if (!line) continue;
          const isCtx = line.indexOf('"turn_context"') !== -1 || line.indexOf('"session_meta"') !== -1;
          if (!isCtx && line.indexOf('"token_count"') === -1) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            status.badLines++;
            continue;
          }
          const p = o && o.payload;
          if (!p || typeof p !== "object") continue;
          if (o.type === "session_meta") {
            if (typeof p.id === "string") session = p.id;
            if (typeof p.model === "string" && !model) model = p.model;
            continue;
          }
          if (o.type === "turn_context") {
            if (typeof p.model === "string" && p.model) model = p.model;
            continue;
          }
          if (o.type !== "event_msg" || p.type !== "token_count" || !p.info) continue;
          const total = p.info.total_token_usage;
          let u = p.info.last_token_usage;
          if (total && prevTotal && sameUsage(total, prevTotal)) {
            status.duplicates++; // Codex re-emits the same cumulative count (e.g. on rate-limit updates)
            continue;
          }
          if (!u && total) u = prevTotal ? diff(total, prevTotal) : total;
          if (total) prevTotal = total;
          if (!u) continue;
          const ts = Date.parse(o.timestamp);
          if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
          const input = tok(u.input_tokens);
          const cached = Math.min(tok(u.cached_input_tokens), input);
          if (!model) fallbackModel++;
          events.push({
            tool: "codex",
            ts,
            model: model || FALLBACK_MODEL,
            session: hashId("codex:" + session),
            input: input - cached,
            output: tok(u.output_tokens), // includes reasoning_output_tokens (billed as output)
            cacheRead: cached,
            cacheWrite: 0,
          });
        }
      } catch {
        log.errors++;
      }
    }
  }
  status.events = events.length;
  status.zstSkipped = zst;
  status.modelFallback = fallbackModel;
  if (zst) status.notes.push(`${zst} compressed .jsonl.zst session file(s) skipped (not supported yet).`);
  if (fallbackModel) status.notes.push(`${fallbackModel} call(s) had no model in the log and were priced as ${FALLBACK_MODEL}.`);
  if (status.found) status.notes.push("Codex logs before 6 Sep 2025 carry no token counts.");
  return { status, events };
}

const KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const sameUsage = (a, b) => KEYS.every((k) => tok(a[k]) === tok(b[k]));
const diff = (a, b) => Object.fromEntries(KEYS.map((k) => [k, Math.max(0, tok(a[k]) - tok(b[k]))]));
