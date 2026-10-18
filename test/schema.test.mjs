import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze } from "../src/analyze.mjs";
import { bundledPrices } from "../src/prices.mjs";
import * as vendored from "../src/summary-schema.mjs";
import { buildSummary, encodeForLink, reportUrl } from "../src/summary.mjs";
import { FIXTURE_HOME, run, runJson } from "./helpers.mjs";

/*
 * The canonical schema is the web worker's feat/v2 src/lib/summary-schema.ts. The CLI ships a COPY
 * (src/summary-schema.mjs, types stripped by scripts/vendor-schema.mjs, pinned by sha256). These tests:
 *   1. always: round-trip CLI fragments through the vendored copy of the web validator;
 *   2. when the git repo is reachable: the pinned commit's file still hashes to the vendored sha256;
 *   3. when Node can strip types (22.18+): IMPORT the canonical .ts itself and decode the CLI fragment with it.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const canonicalAt = (ref) => git("show", `${ref}:src/lib/summary-schema.ts`);
const fragmentOf = (out) => out.match(/https:\/\/devprohacks\.in\/report#(v2\.[A-Za-z0-9_-]+)/)[1];

describe("shared summary schema (canonical: feat/v2 src/lib/summary-schema.ts)", () => {
  test("CLI fragment round-trips through the web validator (vendored copy) unchanged", async () => {
    const { j } = await runJson(["--offline"]);
    const r = await run(["--offline", "--open"]);
    const frag = fragmentOf(r.out);
    assert.ok(frag.startsWith(vendored.FRAGMENT_PREFIX));
    assert.equal(r.out.match(/https:\/\/devprohacks\.in\/report#/)[0], vendored.REPORT_URL + "#");
    const decoded = vendored.decodeSummary("#" + frag);
    assert.ok(decoded, "web validator accepted the CLI fragment");
    assert.deepEqual(decoded, j.summary, "nothing dropped or clamped by the validator");
    assert.deepEqual(vendored.validateSummary(j.summary), j.summary);
  });

  test("payload follows the schema's semantics and buckets", async () => {
    const { j } = await runJson(["--offline"]);
    const s = j.summary;
    assert.equal(s.v, vendored.SUMMARY_VERSION);
    assert.equal(s.src, "cli");
    assert.equal(s.gen, "tokenreceipt/2.0.0");
    assert.deepEqual(s.tools, ["claude-code", "codex", "opencode"]);
    assert.ok(s.models.length <= vendored.MAX_MODELS);
    // largest first by tokens; unmapped merged into one {id:null}
    const sizes = s.models.filter((m) => m.id).map((m) => m.tok.reduce((a, b) => a + b));
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    assert.equal(s.models.filter((m) => m.id === null).length, 1);
    // every request is in exactly one bucket, computed with the schema's own bucketOf
    for (const m of s.models) assert.equal(Object.values(m.b).reduce((n, x) => n + x.n, 0), m.req);
    const opus = s.models.find((m) => m.id === "claude-opus-4.6");
    assert.deepEqual(opus.b, { heavy: { n: 1, t: [200000, 100, 0, 0] } });
    assert.deepEqual(opus.huge, { n: 1, t: [200000, 100, 0, 0] });
    const codex = s.models.find((m) => m.id === "gpt-5.3-codex");
    assert.deepEqual(codex.tok, [7000, 900, 18000, 0]); // uncached input
    // daily sums equal model totals
    for (let i = 0; i < s.models.length; i++) {
      const t = [0, 0, 0, 0];
      for (const r of s.daily.filter((r) => r[1] === i)) for (let k = 0; k < 4; k++) t[k] += r[2 + k];
      assert.deepEqual(t, s.models[i].tok);
    }
    assert.equal(s.sessions.n, 5);
    assert.ok(s.sessions.top.every((x) => Object.keys(x).sort().join() === "d,m,maxCtx,req,t"));
    assert.deepEqual(s.q.warn, ["retention-30d", "codex-zst-skipped", "unmapped-models", "partial-window", "codex-model-fallback", "parse-errors"]);
    assert.equal(s.q.files, 8);
  });

  test("no costs, paths, session ids, raw model names or text in the fragment", async () => {
    const r = await run(["--offline", "--open"]);
    const raw = Buffer.from(fragmentOf(r.out).slice(3), "base64url").toString();
    for (const leak of [FIXTURE_HOME, "s-a", "s-b", "codex-sess-1", "ses_1", "msg_", "mystery", "acme", "FIXTURE", "cost", "/home", "sonnet-5-5-2026"]) assert.ok(!raw.includes(leak), `payload leaks ${leak}`);
  });

  test("oversize summaries shed session detail, then oldest daily rows, to fit the schema cap", () => {
    const N = Date.parse("2026-10-18T12:00:00Z");
    const events = [];
    for (let d = 0; d < 92; d++)
      for (let m = 0; m < 14; m++)
        events.push({ tool: "claude", ts: N - d * 86_400_000, model: ["claude-opus-4-6", "claude-sonnet-5-5", "claude-haiku-4-5", "gpt-5", "gpt-5.3-codex", "gpt-5.1", "gpt-5.2", "gpt-4.1", "o3", "gemini-2.5-pro", "gemini-2.5-flash", "glm-5.1", "grok-4.7", "deepseek-v4-pro"][m], session: `s${d}-${m}`, input: 123456789 + d, output: 98765432 + m, cacheRead: 1234567890123, cacheWrite: 987654321 });
    const a = analyze(events, bundledPrices(), { days: 92, nowMs: N });
    const s = buildSummary(a, {});
    assert.equal(s.models.length, 12);
    assert.equal(s.models.at(-1).id, vendored.OTHER_ID); // mapped models past the cap merge into "other"
    assert.ok(!s.models.some((m) => m.id === null));
    const full = JSON.stringify(vendored.validateSummary(s));
    assert.ok(Buffer.from(full).toString("base64url").length > vendored.MAX_ENCODED_CHARS, "test input really is oversize");
    const frag = encodeForLink(s);
    assert.equal(frag, vendored.encodeSummaryFit(s), "CLI uses the shared shed order, nothing of its own");
    assert.ok(frag.length - 3 <= vendored.MAX_ENCODED_CHARS);
    const back = vendored.decodeSummary(frag);
    assert.ok(back && back.models.length === 12);
    assert.deepEqual(back.models, vendored.validateSummary(s).models, "models and totals never change");
    assert.ok(back.q.warn.includes("partial-window"));
  });

  test("OTHER_ID for overflow mapped models, null for unmapped; both can appear together", () => {
    const N = Date.parse("2026-10-18T12:00:00Z");
    const ids = bundledPrices().rows.filter((r) => r.kind !== "free-promo").slice(0, 14).map((r) => r.id);
    const events = ids.map((model, i) => ({ tool: "codex", ts: N - 3600_000, model, session: "s", input: 1000 * (20 - i), output: 10, cacheRead: 0, cacheWrite: 0 }));
    events.push({ tool: "codex", ts: N - 3600_000, model: "acme/unknown-1", session: "s", input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
    const s = buildSummary(analyze(events, bundledPrices(), { days: 7, nowMs: N }), {});
    assert.equal(s.models.length, 12);
    assert.deepEqual(s.models.slice(-2).map((m) => m.id), [vendored.OTHER_ID, null]);
    assert.equal(s.models.at(-2).req, 14 - 10); // 10 kept + other + null = 12 slots
    assert.deepEqual(vendored.decodeSummary(vendored.encodeSummaryFit(s)), s);
  });

  test("warn codes: fuzzy-model-match, codex-model-fallback, parse-errors", () => {
    const N = Date.parse("2026-10-18T12:00:00Z");
    const e = (model) => ({ tool: "claude", ts: N - 3600_000, model, session: "s", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    const a = analyze([e("claude-sonnet")], bundledPrices(), { days: 7, nowMs: N });
    assert.ok(buildSummary(a, {}).q.warn.includes("fuzzy-model-match"));
    const clean = buildSummary(analyze([e("claude-sonnet-5-5")], bundledPrices(), { days: 7, nowMs: N }), { statuses: [{ tool: "codex", found: true, files: 1, events: 1, badLines: 0, modelFallback: 0 }], log: { files: [], skipped: [], errors: 0 } });
    assert.deepEqual(clean.q.warn, ["partial-window"]); // one call on the last day of a 7-day window; nothing else
    const st = [{ tool: "codex", found: true, files: 1, events: 1, badLines: 0, modelFallback: 2 }];
    assert.ok(buildSummary(a, { statuses: st }).q.warn.includes("codex-model-fallback"));
    assert.ok(buildSummary(a, { log: { files: [], skipped: [], errors: 1 } }).q.warn.includes("parse-errors"));
  });

  test("an empty run has no report link (the schema requires at least one model)", async () => {
    const env = { HOME: "/nonexistent-tr-home", TOKENRECEIPT_NOW: "2026-10-18T12:00:00Z", TOKENRECEIPT_NO_BROWSER: "1" };
    const r = await run(["--offline", "--open"], { env });
    assert.equal(r.code, 0);
    assert.match(r.err, /no report link/);
    assert.equal(reportUrl(buildSummary(analyze([], bundledPrices(), { days: 30, nowMs: Date.now() }), {})), null);
  });

  test("vendored from feat/v2 5d3087a, sha256 06436fe9…7b24", () => {
    assert.equal(vendored.VENDORED_FROM.commit, "5d3087a");
    assert.equal(vendored.VENDORED_FROM.sha256, "06436fe94c80524600f55a3be8b5e0b1ac8f40490c6f74e0cd0ea0e60c117b24");
  });

  test("vendored copy matches the pinned canonical file (sha256)", (t) => {
    const src = canonicalAt(vendored.VENDORED_FROM.commit);
    if (src === null) return t.skip("git repo with the feat/v2 commit not reachable (e.g. installed package)");
    assert.equal(createHash("sha256").update(src).digest("hex"), vendored.VENDORED_FROM.sha256);
    const head = canonicalAt("feat/v2");
    if (head !== null && createHash("sha256").update(head).digest("hex") !== vendored.VENDORED_FROM.sha256)
      t.diagnostic("feat/v2 has a newer summary-schema.ts than the vendored copy: run node cli/scripts/vendor-schema.mjs");
  });

  test("CLI fragment decodes with the canonical TypeScript validator itself (import)", async (t) => {
    if (!process.features?.typescript) return t.skip(`Node ${process.versions.node} cannot import .ts; run on Node 22.18+ to cover this`);
    const src = canonicalAt(vendored.VENDORED_FROM.commit);
    if (src === null) return t.skip("git repo with the feat/v2 commit not reachable");
    const dir = mkdtempSync(path.join(tmpdir(), "tr-schema-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "summary-schema.ts");
    writeFileSync(file, src);
    const web = await import(pathToFileURL(file).href);
    const { j } = await runJson(["--offline"]);
    const frag = fragmentOf((await run(["--offline", "--open"])).out);
    assert.deepEqual(web.decodeSummary("#" + frag), j.summary);
    assert.equal(web.encodeSummaryFit(j.summary), frag, "byte-identical encoding");
    assert.equal(web.OTHER_ID, vendored.OTHER_ID);
  });
});
