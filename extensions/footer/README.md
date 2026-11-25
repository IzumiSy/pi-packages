# footer

Replaces Pi's built-in footer with a compact environment and model status line.

## Display

```text
workstation@developer ~/project (main)        test-model (high) | ctx 42.1%
```

- Left: bold `hostname@username`, Pi's current working directory, and Git branch
- Right: model ID, thinking effort in parentheses (including `off`), and context usage percentage separated by `|`
- Home directory is abbreviated to `~`; paths outside it remain absolute
- Git branch is omitted outside repositories; detached HEAD displays `detached`
- Unknown context usage (such as immediately after compaction) displays `ctx ?%`
- Narrow terminals truncate the left side first, then the right side if necessary
- Other extensions' status messages remain on a separate line with their colors

Uses Pi's branch watcher and current context/model APIs without extra processes or polling. Runs only in terminal mode, applies at session start, and restores the built-in footer on shutdown or reload. No configuration or commands.

The built-in token totals, cost, and session name are not displayed. Other footer-replacement extensions cannot share this surface; the last replacement wins.

## Try locally

From the repository root:

```bash
pi --no-extensions -e ./extensions/footer/main.ts
```
