---
name: update-pr
description: Commit staged changes, push them to the current working branch, and refresh the existing GitHub PR description using the full PR diff and change-impact context. Use when asked to commit and push staged changes and update an existing PR. Does not create a new PR.
compatibility: Requires git and authenticated gh CLI. Cymbal is optional.
---

# Update PR

Commit only staged changes, then update the existing PR description to reflect the whole PR, not just the latest commit.

Before proceeding, read [Create PR](../create-pr/SKILL.md) for its Git safety rules, confidentiality rules, GitHub tooling policy, and description format. Reuse those rules, but do not run its PR creation workflow. An explicit request to run this workflow authorizes commit, push, and description update, subject to those safety rules; discussing the skill or asking for a proposed description does not authorize publication.

## Workflow

### 1. Establish the target before committing

- Read repository instructions and inspect the working-tree status, current branch, remotes, upstream, and staged diff (`git diff --cached`). Stop if there are no staged changes or HEAD is detached.
- Use `gh` to identify the open PR for the current branch. Verify its base repository and branch, head repository and branch, and current description. Account for fork PRs: the push destination must be the PR's head repository, not necessarily its base repository.
- If no open PR exists, stop and suggest `create-pr`; do not create one. If the PR or push destination is ambiguous, ask before committing.
- Determine the destination repository's default branch and the head branch's protection status, applying the safety rules from `create-pr`. Resolve any required confirmation before committing.
- Refresh the intended remote-tracking branch and inspect existing unpushed commits. They will also be published; if their inclusion is not clearly authorized, ask. If local and remote histories have diverged or the remote is ahead, stop rather than automatically pulling, rebasing, or force-pushing.

### 2. Understand the staged change

- Treat `git diff --cached` as the source of truth for the new commit, including partially staged files. Read enough related code to write an accurate commit message.
- If Cymbal is available, read [Cymbal](../cymbal/SKILL.md) and use `cymbal changed` and relevant context or impact queries as supporting evidence. Do not assume its output is limited to staged changes or covers the entire PR; distinguish any unstaged changes from the publication scope.
- If Cymbal is unavailable or cannot cover the change, continue with Git diffs and source inspection. Do not install it automatically.
- Sanitize the commit message and description according to `create-pr`. If staged content appears to contain secrets or unintended sensitive data, stop before publishing and explain the concern.

### 3. Commit and push

- Create a concise commit message describing the staged change and make a normal commit from the existing index. Do not stage additional files, use `git commit -a`, or pass file paths that could include unstaged content.
- Preserve unstaged and untracked changes. Do not automatically fix code, stash changes, amend commits, rewrite history, or bypass hooks. If a hook fails or changes the intended staged content, stop and report the state rather than automatically restaging and retrying.
- Verify the resulting commit matches the intended staged change. Push explicitly to the verified PR head remote and branch without force, and set the upstream to that corresponding remote branch after successful publication. Do not rely on an unverified default push destination.

### 4. Refresh the description from the whole PR

- After a successful push, fetch the PR's current metadata, description, commits, and full base-to-head diff using `gh` with the explicit base repository and PR number. Verify the PR head SHA matches the published commit before editing its description.
- Use the remote PR diff, not the local working tree or only the new commit, as the source of truth for the description. Use Cymbal's relationship information only where it helps explain changes actually included in the PR.
- Update the description as a coherent account of the current PR, not an appended per-commit changelog. Preserve valid Motivation and design rationale from the conversation and existing description; remove stale claims and update Summary. Do not invent motivations or decisions from symbol names or diffs alone.
- Follow `create-pr`'s Motivation / optional Design Decision / Summary format. Preserve useful human-written context, links, and checklists; do not discard unrelated manual content or add Testing, Notes, or other boilerplate sections unless requested.
- Update only the body with `gh pr edit <number> --repo <base-repository> --body-file <path>`. Leave the title, Draft status, base branch, labels, reviewers, and other metadata unchanged.

### 5. Verify and report

- Read back the PR head SHA and description to verify publication and the body update. Report the commit SHA, PR URL, and main description changes.
- If any mutation fails or its outcome is uncertain, inspect the actual Git and PR state before retrying. Report which stages completed: commit, push, and description update. Do not automatically roll back a successful commit or push, create another commit, or repeat an uncertain mutation.
