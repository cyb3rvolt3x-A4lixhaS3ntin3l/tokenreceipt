import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, THRESHOLDS } from "../src/analyze.mjs";
import { parseArgs } from "../src/cli.mjs";
import { bundledPrices, costOf, loadPrices, makeMatcher, PRICES_URL } from "../src/prices.mjs";
import { VERSION } from "../src/util.mjs";
import { baseEnv, run, runJson } from "./helpers.mjs";

const prices = bundledPrices();
const BUNDLED_RAW = JSON.parse(readFileSync(new URL("../data/prices.json", import.meta.url), "utf8"));
/** A valid tokenreceipt.prices/1 table (as GET /api/prices serves it), optionally with one row's rates changed. */
const apiTable = ({ asOf = "2099-01-01", generatedAt = "2099-01-01T00:00:00.000Z", id, rates } = {}) => ({
  ...BUNDLED_RAW,
  asOf,
  generatedAt,
  rows: BUNDLED_RAW.rows.map((r) => (r.id === id ? { ...r, ...rates } : r)),
});
const NOW = Date.parse("2026-10-18T12:00:00Z");
const ev = (o) => ({ tool: "claude", ts: NOW - 3600_000, model: "claude-sonnet-5-5", session: "s1", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...o });

describe("prices", () => {
  test("bundled snapshot is the /api/prices shape (tokenreceipt.prices/1) from the v2 sync, Haiku 5.5 fixed", () => {
    assert.match(prices.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(prices.rows.length > 20);
    assert.deepEqual(Object.keys(BUNDLED_RAW), ["schema", "asOf", "generatedAt", "rows"]);
    assert.equal(BUNDLED_RAW.schema, "tokenreceipt.prices/1");
    for (const r of BUNDLED_RAW.rows) assert.deepEqual(Object.keys(r), ["id", "label", "kind", "input", "output", "cacheRead", "cacheWrite", "aliases", "compare"]);
    assert.ok(BUNDLED_RAW.rows.every((r) => ["vendor", "synced", "single-source", "free-promo", "legacy"].includes(r.kind)));
    const h = prices.rows.find((r) => r.id === "claude-haiku-5.5");
    assert.deepEqual([h.input, h.output, h.cacheRead, h.cacheWrite], [0.1, 0.5, 0.01, 0.125]);
  });
  test("no OpenRouter-sourced data ships: nothing in data/ or src/ mentions it", () => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const f of [...walk(path.join(root, "data")), ...walk(path.join(root, "src"))]) assert.doesNotMatch(readFileSync(f, "utf8"), /openrouter/i, f);
  });
  test("model matching handles dates, dashes, providers", () => {
    const m = makeMatcher(prices);
    assert.equal(m("claude-sonnet-5-5-20261001").row.id, "claude-sonnet-5.5");
    assert.equal(m("anthropic/claude-haiku-4-5").row.id, "claude-haiku-4.5");
    assert.equal(m("zai/glm-5.1").row.id, "glm-5.1");
    assert.equal(m("totally-unknown"), null);
  });
  test("AEC formula; missing cache rates fall back to the input rate", () => {
    const row = { input: 2, output: 10, cacheRead: null, cacheWrite: null };
    assert.equal(costOf(row, { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 2 + 10 + 2 + 2);
    const s = prices.rows.find((r) => r.id === "claude-sonnet-5.5");
    assert.equal(costOf(s, { input: 100, output: 200, cacheRead: 1000, cacheWrite: 500 }), 3550 / 1e6);
  });
  test("--offline never calls fetch", async () => {
    const r = await run(["--offline", "--json"]); // helpers' fetch throws if used
    assert.equal(JSON.parse(r.out).prices.source, "bundled");
  });
  test("online fetch: exact URL, GET, no body, our UA; valid newer table is used", async () => {
    let seen;
    const table = apiTable({ id: "claude-sonnet-5.5", rates: { input: 1, output: 1 } });
    const fetch = async (url, init) => ((seen = { url, init }), new Response(JSON.stringify(table), { status: 200 }));
    const p = await loadPrices({ fetchImpl: fetch });
    assert.equal(seen.url, PRICES_URL);
    assert.equal(seen.url, "https://devprohacks.in/api/prices");
    assert.equal(seen.init.method, "GET");
    assert.equal(seen.init.body, undefined);
    assert.equal(seen.init.headers["user-agent"], `tokenreceipt/${VERSION}`);
    assert.equal(p.source, "online");
    assert.equal(p.asOf, "2099-01-01");
    assert.equal(p.rows.find((r) => r.id === "claude-sonnet-5.5").input, 1);
  });
  test("live table must be tokenreceipt.prices/1: wrong schema, unknown kind, bad rates, duplicate ids are refused", async () => {
    const rej = async (t) => (await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(t)) })).source;
    assert.equal(await rej(apiTable()), "online");
    assert.equal(await rej({ ...apiTable(), schema: "tokenreceipt.prices/2" }), "bundled");
    assert.equal(await rej({ ...apiTable(), generatedAt: "yesterday" }), "bundled");
    assert.equal(await rej(apiTable({ id: "gpt-5", rates: { kind: "host" } })), "bundled");
    assert.equal(await rej(apiTable({ id: "gpt-5", rates: { input: -1 } })), "bundled");
    assert.equal(await rej(apiTable({ id: "gpt-5", rates: { compare: "yes" } })), "bundled");
    assert.equal(await rej({ ...apiTable(), rows: [...apiTable().rows, apiTable().rows[0]] }), "bundled");
    // unknown extra fields are dropped, not kept
    const extra = await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(apiTable({ id: "gpt-5", rates: { sources: [{ name: "x" }] } }))) });
    assert.equal(extra.rows.find((r) => r.id === "gpt-5").sources, undefined);
    // same date, older generatedAt than the bundled copy: keep bundled
    const same = await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(apiTable({ asOf: BUNDLED_RAW.asOf, generatedAt: "2000-01-01T00:00:00Z" }))) });
    assert.match(same.note, /older than bundled/);
  });
  test("bad, old, failing or slow responses fall back to the bundled snapshot", async () => {
    const bad = await loadPrices({ fetchImpl: async () => new Response('{"rows":[{"id":"X","input":-1}]}') });
    assert.equal(bad.source, "bundled");
    const old = await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(apiTable({ asOf: "2001-01-01", generatedAt: "2001-01-01T00:00:00Z" }))) });
    assert.match(old.note, /older than bundled/);
    const http = await loadPrices({ fetchImpl: async () => new Response("no", { status: 404 }) });
    assert.match(http.note, /HTTP 404/);
    const slow = await loadPrices({ timeoutMs: 50, fetchImpl: (u, i) =>
        new Promise((_, rej) => {
          const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout is unref'd; a real socket would hold the loop
          i.signal.addEventListener("abort", () => (clearTimeout(keepAlive), rej(i.signal.reason)));
        }),
    });
    assert.match(slow.note, /timeout/);
  });
  test("end to end against a loopback price server (the only override allowed)", async () => {
    let hits = 0;
    const srv = createServer((req, res) => {
      hits++;
      assert.equal(req.method, "GET");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(apiTable({ id: "claude-opus-4.6", rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}/api/prices`;
    const { j } = await runJson(["--tool", "claude"], { env: baseEnv({ TOKENRECEIPT_PRICES_URL: url }), fetch: globalThis.fetch });
    srv.close();
    assert.equal(hits, 1);
    assert.equal(j.prices.source, "online");
    assert.equal(j.models.find((m) => m.id === "claude-opus-4.6").cost, 0.2); // 200,100 tokens at $1/M
  });
});

describe("analysis and waste flags", () => {
  test("cache ratio = cacheRead / (input + cacheRead + cacheWrite)", () => {
    const a = analyze([ev({ input: 100, cacheRead: 800, cacheWrite: 100 })], prices, { days: 30, nowMs: NOW });
    assert.equal(a.cache.hitRatio, 0.8);
    assert.ok(Math.abs(a.cache.saved - (800 * (2 - 0.1)) / 1e6) < 1e-12);
  });
  test("runaway session: more than 150 calls, or AEC above max($20, P95)", () => {
    const many = Array.from({ length: THRESHOLDS.runawayRequests + 1 }, () => ev({ session: "busy", output: 10 }));
    const pricey = ev({ session: "pricey", model: "claude-opus-4-6", output: 1_000_000 }); // $25
    const a = analyze([...many, pricey, ev({ session: "calm", output: 10 })], prices, { days: 30, nowMs: NOW });
    assert.equal(a.flags.runaway.count, 2);
  });
  test("huge context and top-tier tiny requests", () => {
    const a = analyze(
      [ev({ model: "claude-opus-4-6", input: 10, cacheRead: 150_001, output: 299 }), ev({ model: "claude-opus-4-6", input: 10, output: 300 }), ev({ input: 10, output: 1 })],
      prices,
      { days: 30, nowMs: NOW },
    );
    assert.equal(a.flags.hugeContext.count, 1);
    assert.equal(a.flags.tinyTopTier.count, 1); // sonnet is not top tier; 300 output is not tiny
  });
  test("output-heavy day: > 2x median day and > 60% of the day's cost is output", () => {
    const day = (d, o) => ev({ ts: NOW - d * 86_400_000, ...o });
    const a = analyze([day(1, { input: 1000 }), day(2, { input: 1000 }), day(3, { input: 1000 }), day(4, { output: 10_000 })], prices, { days: 30, nowMs: NOW });
    assert.equal(a.flags.outputHeavyDays.count, 1);
  });
  test("--days limits the window", async () => {
    const { j } = await runJson(["--offline", "--days", "2"]);
    assert.ok(j.daily.length === 2 && j.window.from === "2026-10-17");
    assert.equal(j.totals.requests, 2); // only the two sonnet calls on 17 Oct
  });
});

describe("command line", () => {
  test("options parse; bad input exits 2", async () => {
    assert.deepEqual(parseArgs(["--days=7", "--tool", "codex,claude"]).tools, ["codex", "claude"]);
    assert.equal((await run(["--days", "0"])).code, 2);
    assert.equal((await run(["--days", "93"])).code, 2); // schema keeps at most 92 days
    assert.equal(parseArgs(["check"]).days, 7);
    assert.equal(parseArgs(["check", "--days", "14"]).days, 14);
    assert.equal(parseArgs([]).days, 30);
    assert.equal((await run(["check", "--open"])).code, 2);
    assert.equal((await run(["frobnicate"])).code, 2);
    assert.equal((await run(["--tool", "cursor"])).code, 2);
    assert.equal((await run(["--upload"])).code, 2);
  });
  test("--tool limits the readers", async () => {
    const { j } = await runJson(["--offline", "--tool", "codex"]);
    assert.deepEqual(j.sources.map((s) => s.tool), ["codex"]);
    assert.ok(j.filesRead.every((f) => f.includes(".codex")));
  });
  test("bin runs as an executable with Node", () => {
    const bin = fileURLToPath(new URL("../bin/tokenreceipt.mjs", import.meta.url));
    assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), VERSION);
    const out = execFileSync(process.execPath, [bin, "--offline"], { encoding: "utf8", env: { ...process.env, ...baseEnv(), TZ: "UTC" } });
    assert.match(out, /API-equivalent cost/);
    assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
  });
  test("package.json: zero dependencies, ESM, bin, Node >= 20, allow-listed files", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.name, "tokenreceipt");
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.bin.tokenreceipt, "bin/tokenreceipt.mjs");
    assert.equal(pkg.engines.node, ">=20");
    assert.equal(pkg.license, "MIT");
    assert.ok(pkg.files.includes("LICENSE"));
    assert.match(readFileSync(new URL("../LICENSE", import.meta.url), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 Syed Zada Abrar\n/);
    assert.equal(pkg.repository.url, "git+https://github.com/cyb3rvolt3x-A4lixhaS3ntin3l/tokenreceipt.git");
    assert.equal(pkg.bugs.url, "https://github.com/cyb3rvolt3x-A4lixhaS3ntin3l/tokenreceipt/issues");
    assert.equal(pkg.homepage, "https://devprohacks.in");
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.ok(!pkg.files.some((f) => f.startsWith("test")));
  });
});

describe("r-cli review: hostile price responses and stale prices", () => {
  test("a label or alias with terminal control characters is refused (bundled fallback), and the note is inert", async () => {
    const t = apiTable();
    t.rows = t.rows.map((r, i) => (i === 0 ? { ...r, label: "X\u001b]52;c;cHduZWQ=\u0007" } : r));
    const p = await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(t)) });
    assert.equal(p.source, "bundled");
    const a = apiTable();
    a.rows = a.rows.map((r, i) => (i === 0 ? { ...r, aliases: ["\u001b[2J"] } : r));
    assert.equal((await loadPrices({ fetchImpl: async () => new Response(JSON.stringify(a)) })).source, "bundled");
    const junk = await loadPrices({ fetchImpl: async () => new Response("\u001b[2J\u001b]0;pwned\u0007") });
    assert.equal(junk.source, "bundled");
    assert.doesNotMatch(junk.note, /[\u0000-\u001f\u007f-\u009f]/);
  });
  test("prices older than 7 days are flagged up front (text and --json), never silently", async () => {
    const later = baseEnv({ TOKENRECEIPT_NOW: "2027-01-10T12:00:00Z" });
    const r = await run(["--offline", "--days", "90"], { env: later });
    assert.match(r.out.split("\n")[1], /^  ! Prices are \d+ days old \(bundled table from \d{4}-\d{2}-\d{2}\)/);
    const j = await runJson(["--offline"], { env: later });
    assert.equal(j.j.prices.stale, true);
    assert.ok(j.j.prices.ageDays > 7);
    const c = await run(["check", "--offline"], { env: later });
    assert.match(c.out, /! Prices are \d+ days old/);
    const fresh = await runJson(["--offline"]);
    assert.equal(fresh.j.prices.stale, false);
    assert.doesNotMatch((await run(["--offline"])).out, /Prices are \d+ days old/);
  });
});

describe("r-cli review should-fixes", () => {
  const serve = (t) => async () => new Response(JSON.stringify(t));
  test("sanity floor: a paid row dropping to $0 is refused; known-free and free-promo rows are fine; too many zeros refused", async () => {
    assert.equal((await loadPrices({ fetchImpl: serve(apiTable({ id: "claude-sonnet-5.5", rates: { input: 0, output: 0 } })) })).source, "bundled");
    assert.equal((await loadPrices({ fetchImpl: serve(apiTable()) })).source, "online"); // glm-4.7-flash is $0 in the bundled copy too
    const promo = apiTable({ id: "gpt-5", rates: { kind: "free-promo", input: 0, output: 0 } });
    assert.equal((await loadPrices({ fetchImpl: serve(promo) })).source, "online");
    const many = apiTable();
    many.rows = many.rows.map((r, i) => (i < 12 ? { ...r, kind: "free-promo", input: 0, output: 0, cacheRead: null, cacheWrite: null } : r));
    const p = await loadPrices({ fetchImpl: serve(many) });
    assert.equal(p.source, "bundled");
    assert.match(p.note, /too many zero prices/);
  });
  test("body cap: large Content-Length refused before reading; streamed bodies stop at the cap", async () => {
    let pulled = 0;
    const big = await loadPrices({ fetchImpl: async () => new Response("{}", { headers: { "content-length": "5000000" } }) });
    assert.match(big.note, /response too large/);
    const stream = new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024).fill(32));
        if (pulled > 100) c.close();
      },
    });
    const s = await loadPrices({ fetchImpl: async () => new Response(stream) });
    assert.match(s.note, /response too large/);
    assert.ok(pulled < 30, `stopped early (pulled ${pulled} chunks)`);
  });
  test("files are opened with O_NOFOLLOW: a symlink swapped in after lstat is not followed", async (t) => {
    if (process.platform === "win32") return t.skip("no O_NOFOLLOW on Windows");
    const { READ_FLAGS, readFileNoFollow } = await import("../src/fsread.mjs");
    const { constants, mkdtempSync, symlinkSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    assert.ok(READ_FLAGS & constants.O_NOFOLLOW);
    const d = mkdtempSync(path.join(tmpdir(), "tr-nf-"));
    writeFileSync(path.join(d, "secret"), "x");
    symlinkSync(path.join(d, "secret"), path.join(d, "msg_1.json"));
    await assert.rejects(readFileNoFollow(path.join(d, "msg_1.json")), /ELOOP|EMLINK|symbolic/i);
    rmSync(d, { recursive: true, force: true });
  });
  test("--json omits local paths and raw model names unless --paths", async () => {
    const { FIXTURE_HOME } = await import("./helpers.mjs");
    const r = await runJson(["--offline"], { redacted: true });
    assert.ok(!r.out.includes(FIXTURE_HOME), "no fixture home path");
    for (const leak of ["mystery", "acme", "claude-sonnet-5-5-20261001", "sess-a.jsonl", "rollout-2026", "msg_00", "/.claude", "/.codex"]) assert.ok(!r.out.includes(leak), leak);
    assert.equal(r.j.filesRead, undefined);
    assert.equal(r.j.filesReadCount, 8);
    assert.equal(r.j.unpricedCalls, 1);
    assert.match(r.j.paths, /^omitted/);
    assert.equal(r.j.history.file, "~/.tokenreceipt/last.json");
    const full = await runJson(["--offline", "--paths"]);
    assert.ok(full.j.filesRead.length === 8 && full.out.includes(FIXTURE_HOME));
    assert.match(full.j.paths, /review before sharing/);
  });
});
