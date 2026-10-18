import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";

process.env.TZ = "UTC";
export const FIXTURE_HOME = fileURLToPath(new URL("./fixtures/home", import.meta.url));
export const NOW = "2026-10-18T12:00:00Z";

export const baseEnv = (extra = {}) => ({ HOME: FIXTURE_HOME, TOKENRECEIPT_NOW: NOW, TOKENRECEIPT_NO_BROWSER: "1", ...extra });

const sink = () => {
  const s = { buf: "", write: (x) => ((s.buf += x), true) };
  return s;
};
export const noFetch = () => {
  throw new Error("network must not be used");
};

export async function run(args, { env = baseEnv(), fetch = noFetch, sqlite } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(args, { env, stdout, stderr, fetch, sqlite });
  return { code, out: stdout.buf, err: stderr.buf };
}
/** --json with --paths (full detail) unless opts.redacted, so reader tests can assert on filesRead. */
export async function runJson(args, opts = {}) {
  const r = await run([...args, "--json", ...(opts.redacted || args.includes("--paths") ? [] : ["--paths"])], opts);
  return { ...r, j: JSON.parse(r.out) };
}

export function treeHash(dir) {
  const h = createHash("sha256");
  const rec = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else h.update(p + "\0" + st.mtimeMs + "\0").update(readFileSync(p));
    }
  };
  rec(dir);
  return h.digest("hex");
}
