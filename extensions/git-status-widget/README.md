# git-status-widget

Passive Git status display with a configurable right-side panel or editor widget.

## Surface

- Noncapturing overlay in terminal mode by default; optionally a widget above the editor
- Always a widget above the editor in RPC mode

## Entry point

- `./main.ts`

## Summary

- Reads `git -c core.quotepath=false status --porcelain=v1` without changing Git configuration
- Displays staged, unstaged, and untracked files with colored status codes
- Panel uses 25% of the terminal width at the top right; long paths lose their prefix rather than their filename
- Shows up to eight files with an overflow count; the panel is also constrained to half the terminal height
- Panel keeps a clean-working-tree indicator visible; the widget hides when clean
- Hides outside Git repositories, and hides the panel below 80 columns or 10 rows
- Refreshes after relevant Pi tools and shell commands, plus every five seconds for external edits
- Closes the panel and stops polling on shutdown or reload

The panel uses Pi's experimental overlay API: it covers the conversation underneath rather than reserving a separate sidebar column. It lists changed files, not diff hunks; use `/diff` from `tiggy` to inspect the full diff.

## Configuration

Create `~/.pi/agent/git-status-widget.json` to choose the display in terminal mode:

```json
{
  "display": "widget"
}
```

- `"panel"`: right-side panel, with a fixed width of 25%
- `"widget"`: traditional widget above the editor
- Missing file or missing `display`: defaults to `"panel"`
- Invalid JSON, invalid values, or read errors: warns and falls back to `"panel"`
- RPC mode always uses the widget, regardless of this setting

The file lives in Pi's agent directory; if `PI_CODING_AGENT_DIR` is set, use that directory instead of `~/.pi/agent`. Settings are read at session start. Run `/reload` or restart Pi to apply changes; the file is not watched or written automatically.

## Try locally

From the repository root:

```bash
pi --no-extensions -e ./extensions/git-status-widget/main.ts
```
