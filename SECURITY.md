# Security

`tokenreceipt` is designed to be safe to run on a developer machine:

* No runtime dependencies. Everything is in `bin/`, `src/` and `data/prices.json`; read it before you run it.
* Read-only. Files are opened with read flags; OpenCode's SQLite database is opened with `readOnly: true`, so the database itself is never modified. SQLite may still create or touch its standard `-wal`/`-shm` sidecar files next to the database (as OpenCode itself does); they hold no data of ours.
* The only write, and only with `--save`: `~/.tokenreceipt/last.json` (aggregates only), written atomically with mode
  0600 in a 0700 directory. A symlinked `~/.tokenreceipt` or `last.json` is refused.
* Fixed roots (see README). Directory walks never follow symlinks, and files are opened with `O_NOFOLLOW` where the
  OS supports it. Credential-like filenames (`auth`, `credentials`,
  `token`, `secret`, `.env`, …) are refused even inside those roots and listed as "Not read".
* Every file opened is listed in the output (`filesRead` in `--json`).
* Network: one optional `GET https://devprohacks.in/api/prices`, no request body, no cookies, redirects refused,
  response strictly validated (byte cap enforced on Content-Length and while streaming; a paid model dropping to $0,
  or a table full of $0 rows, is refused). `--offline` disables it. No telemetry.
* `--open` puts an aggregates-only summary in the URL fragment, which browsers do not send to servers.

Report a vulnerability to hello@devprohacks.in. Please do not open a public issue for security problems.
