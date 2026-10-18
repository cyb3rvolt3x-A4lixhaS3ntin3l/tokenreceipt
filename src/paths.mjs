import os from "node:os";
import path from "node:path";

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const uniq = (a) => [...new Set(a.map((p) => path.resolve(p)))];

/**
 * The only directories tokenreceipt ever looks in. Everything it reads is inside one of these, and only
 * session/message files are opened there: never auth.json, .credentials.json, config, or .env.
 */
export function roots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgData = env.XDG_DATA_HOME || path.join(home, ".local", "share");

  const claudeBases = list(env.CLAUDE_CONFIG_DIR).length
    ? list(env.CLAUDE_CONFIG_DIR)
    : [path.join(xdgConfig, "claude"), path.join(home, ".claude")];
  const codexBases = list(env.CODEX_HOME).length ? list(env.CODEX_HOME) : [path.join(home, ".codex")];
  const opencodeBases = list(env.OPENCODE_DATA_DIR).length ? list(env.OPENCODE_DATA_DIR) : [path.join(xdgData, "opencode")];

  return {
    claude: { projects: uniq(claudeBases.map((b) => path.join(b, "projects"))) },
    codex: {
      sessions: uniq(codexBases.map((b) => path.join(b, "sessions"))),
      archived: uniq(codexBases.map((b) => path.join(b, "archived_sessions"))),
    },
    opencode: {
      dataDirs: uniq(opencodeBases),
      legacy: uniq(opencodeBases.map((b) => path.join(b, "storage", "message"))),
    },
  };
}
