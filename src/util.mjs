import { createHash } from "node:crypto";

export const VERSION = "2.0.0";
export const USER_AGENT = `tokenreceipt/${VERSION}`;

/** Session ids are hashed in memory and never printed or encoded. */
export const hashId = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

/** C0/C1 controls, DEL and bidi overrides: never let a log string or a fetched label drive the terminal. */
export const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export const clean = (v) => String(v).replace(new RegExp(CTRL_RE.source, "g"), "?");

export const b64urlEncode = (str) => Buffer.from(str, "utf8").toString("base64url");
export const b64urlDecode = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  return Buffer.from(s, "base64url").toString("utf8");
};

/** Non-negative finite integer, else 0. Token counts in logs are trusted only this far. */
export const tok = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** Local calendar day YYYY-MM-DD for a ms timestamp. */
export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 1 : 2) + "K";
  return String(Math.round(n));
}
export const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
export const pct = (r) => `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
