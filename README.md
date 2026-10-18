# tokenreceipt

Find out if you're overpaying for AI coding, in 10 seconds, without uploading anything.

`tokenreceipt` is a small command-line tool that reads the usage logs your AI coding tools already keep on your machine (Claude Code, Codex, OpenCode) and tells you what that usage costs on other models and plans, with a ranked list of ways to spend less.

- **Local only.** It reads files on your computer, prints which paths it read, and never uploads your usage. The optional `--open` flag puts a summary after the `#` in a [devprohacks.in](https://devprohacks.in) link, so it is never sent to a server.
- **Read-only.** It never reads auth or token files.
- **Zero dependencies.** Node 18+.
- **Estimates, not promises.** Prices are dated and sourced; plan comparisons are ranges.

## Usage

```sh
npx tokenreceipt          # analyse local usage and print a summary
npx tokenreceipt --json   # machine-readable output
npx tokenreceipt --open   # open the full web report
```

> Status: in development. The first release is coming soon.

## License

MIT
