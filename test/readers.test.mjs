import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadSqlite, SQLITE_FALLBACK_HINT } from "../src/readers/opencode.mjs";
import { baseEnv, FIXTURE_HOME, run, runJson, treeHash } from "./helpers.mjs";

const src = (j, tool) => j.sources.find((s) => s.tool === tool);

describe("Claude Code", () => {
  test("reads both roots incl. subagents, dedupes streamed lines, skips synthetic/old/bad lines", async () => {
    const { j } = await runJson(["--offline", "--tool", "claude"]);
    const s = src(j, "claude");
    assert.equal(s.events, 4);
    assert.equal(s.duplicates, 1);
    assert.equal(s.badLines, 1);
    assert.deepEqual(
      { i: j.totals.input, o: j.totals.output, cr: j.totals.cacheRead, cw: j.totals.cacheWrite, n: j.totals.requests },
      { i: 100 + 50 + 10 + 200000, o: 200 + 400 + 20 + 100, cr: 3000, cw: 500, n: 4 },
    );
    assert.ok(j.filesRead.some((f) => f.includes(path.join(".config", "claude", "projects"))));
    assert.ok(j.filesRead.some((f) => f.endsWith(path.join("subagents", "agent-1.jsonl"))));
    const sonnet = j.models.find((m) => m.id === "claude-sonnet-5.5");
    // (100*2 + 200*10 + 1000*0.1 + 500*2.5 + 50*2 + 400*10 + 2000*0.1) / 1e6
    assert.equal(sonnet.cost, Math.round(((3550 + 4300) / 1e6) * 100) / 100);
    assert.deepEqual(sonnet.rawModels, ["claude-sonnet-5-5-20261001"]);
  });

  test("CLAUDE_CONFIG_DIR (comma list) replaces the default roots", async () => {
    const env = baseEnv({ CLAUDE_CONFIG_DIR: path.join(FIXTURE_HOME, ".config", "claude") });
    const { j } = await runJson(["--offline", "--tool", "claude"], { env });
    assert.equal(src(j, "claude").events, 1);
    assert.equal(j.models[0].id, "claude-opus-4.6");
  });
});

describe("Codex", () => {
  test("subtracts cached from input, uses deltas when last_token_usage is missing, skips repeats, archived copies and .zst", async () => {
    const { j } = await runJson(["--offline", "--tool", "codex"]);
    const s = src(j, "codex");
    assert.equal(s.events, 3);
    assert.equal(s.duplicates, 2); // repeated cumulative count + archived copy of an active rollout
    const codex = j.models.find((m) => m.id === "gpt-5.3-codex");
    assert.equal(codex.input, 2000 + 5000); // (10000-8000) + ((25000-10000)-(18000-8000))
    assert.equal(codex.cacheRead, 8000 + 10000);
    assert.equal(codex.output, 500 + 400);
    assert.equal(codex.requests, 2);
    assert.ok(!j.filesRead.some((f) => f.includes("archived_sessions") && f.endsWith("abc.jsonl")), "active copy wins");
    assert.ok(s.notes.some((n) => /1 compressed \.jsonl\.zst/.test(n)));
    assert.ok(s.notes.some((n) => /priced as gpt-5/.test(n)));
    assert.equal(j.models.find((m) => m.id === "gpt-5").input, 1000);
  });
});

describe("OpenCode", () => {
  test("legacy storage/message JSON: assistant only, reasoning billed as output, unpriced reported", async () => {
    const { j } = await runJson(["--offline", "--tool", "opencode"], { sqlite: null });
    const s = src(j, "opencode");
    assert.equal(s.events, 2);
    const glm = j.models.find((m) => m.id === "glm-5.1");
    assert.deepEqual([glm.input, glm.output, glm.cacheRead], [300, 60, 700]);
    assert.deepEqual(j.unpriced, [{ model: "acme/mystery-model-x", calls: 1 }]);
  });

  test("without node:sqlite the database is skipped with a clear message", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tr-oc-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "opencode.db"), "not opened");
    const { j, out } = await runJson(["--offline", "--tool", "opencode"], { env: baseEnv({ OPENCODE_DATA_DIR: dir }), sqlite: null });
    const note = src(j, "opencode").notes.join(" ");
    assert.match(note, /needs Node 22\.13\+/);
    assert.ok(note.includes(SQLITE_FALLBACK_HINT));
    assert.ok(!j.filesRead.includes(path.join(dir, "opencode.db")));
    assert.deepEqual(j.notRead.map((x) => x.reason), ["node:sqlite unavailable"]);
    void out;
  });

  test("SQLite opencode.db via node:sqlite, read-only, deduped with legacy JSON and forked rows", async (t) => {
    const sqlite = await loadSqlite();
    if (!sqlite) return t.skip(`node:sqlite not available on Node ${process.versions.node}; run tests on Node 22.13+ to cover this`);
    const dir = mkdtempSync(path.join(tmpdir(), "tr-oc-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(path.join(FIXTURE_HOME, ".local/share/opencode/storage"), path.join(dir, "storage"), { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
    db.exec("CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT)");
    db.exec("CREATE TABLE part (id TEXT, data TEXT)");
    const msg = (id, input) => JSON.stringify({ id, role: "assistant", providerID: "zai", modelID: "glm-5.1", sessionID: "ses_2", time: { created: Date.parse("2026-10-17T08:00:00Z") }, tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } });
    const ins = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
    ins.run("msg_sql_1", "ses_2", 0, msg("msg_sql_1", 1000));
    ins.run("msg_001", "ses_1", 0, JSON.parse(JSON.stringify(msg("msg_001", 300)))); // same id as a legacy file
    db.prepare("INSERT INTO session_message VALUES (?,?,?)").run("msg_sql_1", "ses_fork", msg("msg_sql_1", 1000));
    db.prepare("INSERT INTO part VALUES (?,?)").run("p1", msg("p1", 999999));
    db.close();
    const before = treeHash(dir);
    const { j } = await runJson(["--offline", "--tool", "opencode"], { env: baseEnv({ OPENCODE_DATA_DIR: dir }), sqlite });
    const s = src(j, "opencode");
    assert.ok(j.filesRead.includes(path.join(dir, "opencode.db")));
    assert.equal(s.duplicates, 2); // fork row + legacy msg_001
    assert.equal(s.events, 3); // msg_sql_1, msg_001, msg_003
    assert.equal(j.models.find((m) => m.id === "glm-5.1").input, 1300);
    assert.equal(treeHash(dir), before, "database untouched");
  });
});

describe("read-only and never touches credentials", () => {
  test("no fixture file changes; auth/credential/config files are never opened or counted", async () => {
    const before = treeHash(FIXTURE_HOME);
    const { j, out } = await runJson(["--offline"]);
    assert.equal(treeHash(FIXTURE_HOME), before);
    for (const f of j.filesRead) assert.doesNotMatch(path.basename(f), /auth|credential|config\.toml|\.env/);
    assert.ok(j.notRead.some((x) => x.path.endsWith("auth.jsonl")));
    assert.ok(!out.includes("FIXTURE-SECRET-DO-NOT-READ"));
    assert.ok(!out.includes("FIXTURE-PROMPT-TEXT"));
    assert.ok(j.totals.input < 123456789, "decoy usage inside auth.jsonl was not counted");
    assert.equal(j.filesRead.length, 8);
  });

  test("terminal output lists every file read and what was refused", async () => {
    const { out, code } = await run(["--offline"]);
    assert.equal(code, 0);
    assert.match(out, /Files read \(8\):/);
    assert.ok(out.includes(path.join(FIXTURE_HOME, ".codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-abc.jsonl")));
    assert.match(out, /Not read: .*auth\.jsonl \(credential-like name, never read\)/);
  });

  test("--dry-run opens nothing and reports directories with file counts", async () => {
    const { out } = await run(["--dry-run"]);
    assert.match(out, /nothing is opened or parsed/);
    assert.ok(out.includes(`${path.join(FIXTURE_HOME, ".claude", "projects")}  (2 file(s))`));
    assert.doesNotMatch(out, /Files read/);
  });
});
