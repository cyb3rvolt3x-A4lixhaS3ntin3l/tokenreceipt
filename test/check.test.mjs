import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { FIXTURE_HOME, run, runJson, treeHash } from "./helpers.mjs";

let home;
const env = (now = "2026-10-18T12:00:00Z") => ({ HOME: home, TOKENRECEIPT_NOW: now, TOKENRECEIPT_NO_BROWSER: "1" });
const hist = () => path.join(home, ".tokenreceipt");
const last = () => path.join(hist(), "last.json");
const roots = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
beforeEach(() => {
  const d = mkdtempSync(path.join(tmpdir(), "tr-check-"));
  roots.push(d);
  home = path.join(d, "home");
  cpSync(FIXTURE_HOME, home, { recursive: true });
});

describe("check (weekly re-check against ~/.tokenreceipt/last.json)", () => {
  test("without --save nothing is written anywhere", async () => {
    const before = treeHash(home);
    const r = await run(["check", "--offline"], { env: env() });
    assert.equal(r.code, 0);
    assert.match(r.out, /No previous run saved/);
    assert.match(r.out, /Not saved\. Run `npx tokenreceipt check --save`/);
    assert.ok(!existsSync(hist()));
    assert.equal(treeHash(home), before);
    await run(["--offline"], { env: env() });
    assert.ok(!existsSync(hist()), "plain runs never write either");
  });

  test("--save writes only ~/.tokenreceipt/last.json (0700 dir, 0600 file), aggregates only", async () => {
    const r = await run(["check", "--offline", "--save"], { env: env("2026-10-11T12:00:00Z") });
    assert.equal(r.code, 0);
    assert.match(r.out, /Saved this run to .*last\.json/);
    if (process.platform !== "win32") {
      assert.equal(statSync(hist()).mode & 0o777, 0o700);
      assert.equal(statSync(last()).mode & 0o777, 0o600);
    }
    const text = readFileSync(last(), "utf8");
    for (const leak of [FIXTURE_HOME, home, "codex-sess", "s-a", "ses_1", "FIXTURE", "mystery"]) assert.ok(!text.includes(leak), `history leaks ${leak}`);
    const j = JSON.parse(text);
    assert.equal(j.schema, "tokenreceipt.last/1");
    assert.deepEqual(j.models.map((m) => m.id), ["gpt-5"]); // only the 10 Oct call is in 5-11 Oct
  });

  test("a week later, check compares with the saved run and lists the history file as read", async () => {
    await run(["check", "--offline", "--save"], { env: env("2026-10-11T12:00:00Z") });
    const r = await run(["check", "--offline"], { env: env() });
    assert.match(r.out, /Compared with the run saved 2026-10-11 \(2026-10-05 to 2026-10-11, 7 days\)/);
    assert.match(r.out, /New models +claude-opus-4\.6/);
    assert.match(r.out, /Not used this time +gpt-5\b/);
    assert.ok(r.out.includes(last()), "history file is listed among files read");
    const { j } = await runJson(["check", "--offline"], { env: env() });
    assert.equal(j.comparison.basis, "totals");
    assert.equal(j.comparison.requests.prev, 1);
    assert.equal(j.comparison.requests.cur, 8);
    assert.ok(j.filesRead.includes(last()));
    assert.equal(j.summary, undefined);
  });

  test("different window lengths are compared as per-day averages", async () => {
    await run(["--offline", "--save", "--days", "14"], { env: env() });
    const { j } = await runJson(["check", "--offline"], { env: env() });
    assert.equal(j.comparison.basis, "per-day averages");
    assert.equal(j.comparison.requests.prev, 9 / 14);
    assert.equal(j.comparison.requests.cur, 8 / 7);
  });

  test("refuses a symlinked ~/.tokenreceipt and never writes through it", async (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
    const target = path.join(path.dirname(home), "elsewhere");
    mkdirSync(target);
    symlinkSync(target, hist());
    const r = await run(["check", "--offline", "--save"], { env: env() });
    assert.equal(r.code, 1);
    assert.match(r.err, /not saved: .*not a plain directory/);
    assert.ok(!existsSync(path.join(target, "last.json")));
  });

  test("a corrupt or foreign last.json is ignored with a message, not trusted", async () => {
    mkdirSync(hist(), { mode: 0o700 });
    writeFileSync(last(), JSON.stringify({ schema: "something-else", totals: { cost: 1e9 } }));
    const r = await run(["check", "--offline"], { env: env() });
    assert.equal(r.code, 0);
    assert.match(r.out, /not a tokenreceipt history file; ignored/);
    writeFileSync(last(), "{not json");
    assert.match((await run(["check", "--offline"], { env: env() })).out, /could not read/);
  });
});
