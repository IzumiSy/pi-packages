# git-status-widget

Passive widget that shows the current git status in the Pi UI.

## Surface

- Widget

## Entry point

- `./main.ts`

## Summary

- Reads `git status --porcelain=v1`
- Displays staged, unstaged, and untracked files
- Refreshes on relevant Pi tool activity and with a slow background poll
