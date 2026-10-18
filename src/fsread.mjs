import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Read-only file access with a ledger of every path opened. Directory walks never follow symlinks (no escape outside
 * the tool roots), and any file whose name looks like a credential is refused even if a walk reaches it.
 */
const DENY = /(^|[._-])(auth|credentials?|secrets?|tokens?|api[_-]?keys?|keychain|cookies?)([._-]|$)|^\.env/i;
export const isDeniedName = (file) => DENY.test(path.basename(file));

/** O_RDONLY | O_NOFOLLOW where the platform has it: a file swapped for a symlink after lstat is refused, not followed. */
export const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

/** Read a whole small file through a no-follow, read-only handle. */
export async function readFileNoFollow(file) {
  const fh = await open(file, READ_FLAGS);
  try {
    return await fh.readFile({ encoding: "utf8" });
  } finally {
    await fh.close();
  }
}

export class ReadLog {
  constructor() {
    this.files = []; // every file actually opened, in order
    this.dirs = new Map(); // root -> { files, bytes }
    this.skipped = []; // { path, reason }
    this.errors = 0;
  }
  opened(file, root, bytes = 0) {
    this.files.push(file);
    const d = this.dirs.get(root) || { files: 0, bytes: 0 };
    d.files++;
    d.bytes += bytes;
    this.dirs.set(root, d);
  }
  skip(file, reason) {
    this.skipped.push({ path: file, reason });
  }
}

export async function isDir(p) {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
export async function isFile(p) {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

/** Recursively list regular files under root whose name passes `accept`. Symlinks are skipped, not followed. */
export async function walk(root, accept, maxDepth = 8) {
  const out = [];
  async function rec(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await rec(p, depth + 1);
      else if (e.isFile() && accept(e.name, p)) out.push(p);
    }
  }
  await rec(root, 0);
  return out;
}

/** Stream a text file line by line (constant memory). Records the open in the ledger. */
export async function* readLines(file, log, root) {
  if (isDeniedName(file)) {
    log.skip(file, "credential-like name, never read");
    return;
  }
  const st = await lstat(file);
  if (!st.isFile()) return;
  log.opened(file, root, st.size);
  const rl = createInterface({ input: createReadStream(file, { flags: READ_FLAGS, encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** Read a small JSON file (OpenCode legacy messages). Max 2 MB. */
export async function readSmallJson(file, log, root) {
  if (isDeniedName(file)) {
    log.skip(file, "credential-like name, never read");
    return null;
  }
  const st = await lstat(file);
  if (!st.isFile() || st.size > 2 * 1024 * 1024) {
    log.skip(file, "too large or not a regular file");
    return null;
  }
  log.opened(file, root, st.size);
  try {
    return JSON.parse(await readFileNoFollow(file));
  } catch {
    log.errors++;
    return null;
  }
}
