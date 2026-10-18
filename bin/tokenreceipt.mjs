#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on some Node versions; hide only that one.
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === "string" ? w : w && w.message;
  if (/sqlite/i.test(String(msg || ""))) return;
  return emit.call(process, w, ...rest);
};
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`tokenreceipt needs Node 20 or later (you have ${process.versions.node}).`);
  process.exit(1);
}
const { main } = await import("../src/cli.mjs");
process.exitCode = await main(process.argv.slice(2));
