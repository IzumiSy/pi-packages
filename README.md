# Pi Packages

Custom Pi extensions for my development workflow.

## Install

```bash
pi install git:github.com/IzumiSy/pi-packages
```

## Extensions

| Extension                                                       | What it does                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`git-branch-switch`](./extensions/git-branch-switch/README.md) | Switch to a local/remote branch or check out an open pull request with fuzzy matching and a TUI picker.    |
| [`tiggy`](./extensions/tiggy/README.md)                         | Browse git history and working tree diffs in a TUI, with previews and in-preview search.                   |
| [`git-status-widget`](./extensions/git-status-widget/README.md) | Shows current git status entries for the working tree, including staged, unstaged, and untracked files.    |
| [`command-gate`](./extensions/command-gate/README.md)           | Blocks or asks for confirmation on matching bash commands, and provides tools to inspect and manage rules. |
| [`command-handoff`](./extensions/command-handoff/README.md)     | Provides `request_command_handoff` to stage user-run shell commands and resume after their results.        |
| [`project-notes`](./extensions/project-notes/README.md)         | Keeps personal Markdown notes outside the repository, shared across clones with the same origin.           |

## Skills

- [`create-pr`](./skills/create-pr/SKILL.md) — Create a GitHub PR with a contextual description, safe branch handling, and sanitized public-facing text. Defaults to a Draft PR. Invoke with `/skill:create-pr`; requires `git` and authenticated `gh`.
- [`update-pr`](./skills/update-pr/SKILL.md) — Commit staged changes, push them, and refresh an existing PR description from the full PR diff. Invoke with `/skill:update-pr`; requires `git` and authenticated `gh`. Cymbal is optional.
- [`cymbal`](./skills/cymbal/SKILL.md) — Prefer [Cymbal](https://cymbal.sh/) for code search and navigation over grep, ripgrep, and find. Requires the `cymbal` CLI.
- [`permission-handoff`](./skills/permission-handoff/SKILL.md) — Guides permission-error recovery through `request_command_handoff`, without automatically retrying or escalating privileges.
- [`pr-review-plan`](./skills/pr-review-plan/SKILL.md) — Collect unresolved GitHub PR review threads and propose a concrete plan for each. Invoke with `/skill:pr-review-plan`; requires Node.js, `git`, and authenticated `gh`.

For development notes, see [DEVELOPMENT.md](./DEVELOPMENT.md).
