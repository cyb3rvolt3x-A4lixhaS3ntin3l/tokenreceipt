# tokenreceipt

What your AI coding agents would cost at list API prices, from the logs already on your machine.

```
npx tokenreceipt
```

* **Read-only, zero dependencies, Node 20+.** It reads local usage logs, prints a summary, and lists every file it
  opened. Nothing about your usage is uploaded. It writes nothing unless you pass `--save` (see `check`).
* **Sources:** Claude Code, Codex CLI, OpenCode.
* **One optional network call:** `GET https://devprohacks.in/api/prices` for the current price table (3 s timeout,
  no body, no cookies, strictly validated `tokenreceipt.prices/1`). It falls back to the bundled copy of the same
  table; `--offline` skips it. Prices come from vendor pricing pages plus LiteLLM and models.dev (both MIT).

## Options

| | |
|---|---|
| `check` | weekly re-check: compare the last 7 days with the previous run saved in `~/.tokenreceipt/last.json` |
| `--save` | with your consent, save this run's aggregates to `~/.tokenreceipt/last.json` (dir 0700, file 0600). The only file tokenreceipt ever writes (SQLite may create its standard `-wal`/`-shm` sidecars next to `opencode.db` when reading it; the database is never modified). |
| `--days N` | window, 1 to 92 days (default 30; 7 for `check`) |
| `--tool claude,codex,opencode` | limit sources |
| `--json` | machine-readable output. Local file paths and raw model names are left out unless you add `--paths`; review before sharing either way. |
| `--open` | build a `https://devprohacks.in/report#v2.…` link and open it. The summary is after `#`, which browsers never send to a server. Aggregates only: no paths, session ids or prompt text. |
| `--offline` | no network at all; bundled prices |
| `--dry-run` | list the directories and file counts that would be read, open nothing |
| `--paths` | always list every file read (the default lists them when there are 40 or fewer); with `--json`, include paths and raw model names |

## What it reads, and nothing else

| Tool | Location (env override) | Files opened |
|---|---|---|
| Claude Code | `~/.config/claude/projects`, `~/.claude/projects` (`$CLAUDE_CONFIG_DIR`, comma list) | `*.jsonl`, including `subagents/` |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` (`$CODEX_HOME`, comma list) | `*.jsonl` (`.jsonl.zst` skipped and counted) |
| OpenCode | `~/.local/share/opencode` (`$OPENCODE_DATA_DIR`, `$XDG_DATA_HOME`) | `opencode.db` / `opencode-*.db` (read-only, needs Node 22.13+ for built-in `node:sqlite`; otherwise skipped with a message), `storage/message/*/msg_*.json` |

Never opened: `auth.json`, `.credentials.json`, config files, `.env`, anything with a credential-like name, anything
reached through a symlink, and the Cursor database. From each log line only the model, token counts, timestamp and
session id are used; session ids are hashed in memory and never printed.

Notes: Claude Code deletes local logs after 30 days by default (`cleanupPeriodDays`). Codex logs before 6 Sep 2025 have
no token counts. Costs are API-equivalent, not your subscription bill. Waste-flag thresholds are ours.

Weekly habit: `npx tokenreceipt check --save` once a week compares with last week and saves the new baseline.

Report link format: the shared v2 summary schema (canonical `src/lib/summary-schema.ts` in the web app; the CLI ships a
generated copy in `src/summary-schema.mjs`). Aggregates only: price-table model ids, token and request counts, day
offsets, request-size buckets. No costs, paths, session ids, raw model names or text. See `docs/schema-notes.md`.

MIT licence. Copyright (c) 2026 Syed Zada Abrar.
