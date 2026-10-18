import { isDeniedName, isDir, readLines, walk } from "../fsread.mjs";
import { hashId, tok } from "../util.mjs";

/**
 * Claude Code: <projects>/<project>/<session>.jsonl and <session>/subagents/*.jsonl.
 * Only `message.usage`, `message.model`, `message.id`, `requestId`, `sessionId` and `timestamp` are used; message
 * text is parsed by JSON.parse (unavoidable for JSONL) but never kept. Streamed lines are deduped on message.id+requestId.
 */
export async function readClaude(r, { log, sinceMs, untilMs }) {
  const status = { tool: "claude", roots: [], found: false, files: 0, events: 0, duplicates: 0, badLines: 0, notes: [] };
  const seen = new Set();
  const events = [];
  for (const root of r.claude.projects) {
    if (!(await isDir(root))) continue;
    status.found = true;
    status.roots.push(root);
    const files = await walk(root, (n) => n.endsWith(".jsonl"), 6);
    for (const f of files) {
      if (isDeniedName(f)) {
        log.skip(f, "credential-like name, never read");
        continue;
      }
      status.files++;
      try {
        for await (const line of readLines(f, log, root)) {
          if (!line || line.indexOf('"usage"') === -1) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            status.badLines++;
            continue;
          }
          const m = o && o.message;
          const u = m && m.usage;
          if (!u || typeof u !== "object") continue;
          const model = typeof m.model === "string" ? m.model : "";
          if (!model || model === "<synthetic>") continue;
          const ts = Date.parse(o.timestamp);
          if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
          if (typeof m.id === "string" && typeof o.requestId === "string") {
            const key = m.id + "\u0000" + o.requestId;
            if (seen.has(key)) {
              status.duplicates++;
              continue;
            }
            seen.add(key);
          }
          events.push({
            tool: "claude",
            ts,
            model,
            session: hashId("claude:" + (o.sessionId || f)),
            input: tok(u.input_tokens),
            output: tok(u.output_tokens),
            cacheRead: tok(u.cache_read_input_tokens),
            cacheWrite: tok(u.cache_creation_input_tokens),
          });
        }
      } catch {
        log.errors++;
      }
    }
  }
  status.events = events.length;
  if (status.found) status.notes.push("Claude Code deletes local logs after 30 days by default (cleanupPeriodDays).");
  return { status, events };
}
