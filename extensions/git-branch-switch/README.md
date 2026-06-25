# git-branch-switch

Switch git branches or check out pull requests from Pi.

## Surface

- Slash command: `/switch`

## Entry point

- `./main.ts`

## Summary

- Lists local and remote branches
- Supports fuzzy matching from command arguments
- Can also list and check out open GitHub pull requests via `gh`
- Falls back to a TUI picker when needed
