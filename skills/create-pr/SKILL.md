---
name: create-pr
description: Create a GitHub pull request with a contextual description, safe branch handling, and sanitized public-facing text. Use when asked to create or open a PR, or prepare a PR title and description. Defaults to a Draft PR.
compatibility: Requires git and authenticated gh CLI for PR creation.
---

# Create PR

## Workflow

1. Inspect the repository instructions, working-tree status, current branch, remote, intended base branch, and changes to include. Read the relevant diff and commits so the title and description reflect the actual change and the user's motivation.
2. Confirm the target repository and branches. Check whether a PR already exists for the working branch; if one exists, report its URL instead of creating a duplicate.
3. Read [the shared PR description reference](../references/pr-description.md), then prepare a concise title and description following its format and writing rules. Sanitize all public-facing text before publishing.
4. Only push and create the PR when the user has explicitly requested publication. A request to prepare a title or description is not authorization to publish. Follow the Git safety rules below, then use `gh pr create` with explicit base, head, title, and body. Include `--draft` unless the user explicitly requests a non-draft PR. Prefer `--body-file` to preserve multiline Markdown.
5. Return the created PR's URL and whether it is a draft. If creation fails or its outcome is uncertain, inspect the current PR state before retrying.

## GitHub tools

- Use `gh` CLI by default for GitHub interactions.
- Do not use browser/chrome tools for GitHub write actions unless explicitly requested or `gh` is unavailable.
- Use browser/chrome tools only for troubleshooting, page inspection, and behavior or visual verification.
- Prefer non-browser workflows whenever a reliable CLI or direct tool is available.

## Git safety

- Before pushing, determine the default branch. If it cannot be determined confidently, stop and ask.
- Never push directly to the default branch or any branch known to be protected without explicit user confirmation in the current conversation.
- If the push target is unclear, or the current branch tracks the default branch or another branch known to be protected, stop and ask before pushing.
- A working branch may start from the default branch, but must not track the default branch or another branch known to be protected.
- After publishing a working branch, set its upstream to its corresponding remote branch, for example `git push -u origin HEAD` after verifying the intended remote and branch.
- Do not commit unrelated working-tree changes merely to create a PR.

## Confidentiality in public Git history

- Never include specific company names, customer names, or other identifying information of clients in commit messages, PR titles, or PR descriptions.
- Use generic terms such as "a customer", "a client", or "an external partner" instead of real names.
- Sanitize before writing any public-facing Git artifact, even when the user's conversation mentions specific names.

## PR defaults

Create new GitHub PRs as Draft PRs by default unless the user explicitly asks for a non-draft PR.
