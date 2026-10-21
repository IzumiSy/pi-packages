# project-notes

Personal Markdown notes stored outside the repository, shared across clones with the same origin.

## Surface

- `/notes` command
- `notes_list`, `notes_read`, `notes_create`, and `notes_update` tools

## Entry point

- `./main.ts`

## Usage

Ask Pi to save a design memo or draft as a project note. Conversations are not automatically saved. Unless you explicitly request a repository path, project notes are the default destination for requested draft/memo saves.

Open `/notes` to see the current project and select a note:

- **Read privately** opens Pi's existing multi-line editor as a viewer. Edits are discarded; nothing is sent to the model or saved.
- **Send to conversation** sends the first page to the current model and starts/queues a turn. Long notes include instructions for fetching the remaining pages.

In the terminal note list, use **↑/↓** or **j/k** to move, **Enter** to open, and **d** to delete the highlighted note. Deletion requires a confirmation showing the project, ID, and title, then refreshes the list. **Esc** closes the list; cancelling confirmation leaves the note unchanged. A note changed by another writer during confirmation is not deleted—reopen the list and confirm the latest version. Deletion is permanent, shared across clones, and cannot be undone by session rewind. This shortcut is TUI-only; RPC keeps the standard read/send dialogs. No model-facing delete tool is exposed.

Tools also work without an interactive UI. Every successful tool result identifies the project being accessed.

| Tool           | Inputs                                     | Purpose                                                                                                                                                                 |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes_list`   | Optional `query`, `offset`, `limit`        | List summaries or search ID/title/body with a case-insensitive literal string. At most 10 results per page; follow `nextOffset`. Search results include short excerpts. |
| `notes_read`   | `id`, optional `offset`, `revision`        | Get body pages and the content hash used as a revision. Pages contain at most 8,000 UTF-16 code units or 1,000 lines.                                                   |
| `notes_create` | `id`, complete Markdown `body`             | Create a new note; never overwrite an existing ID.                                                                                                                      |
| `notes_update` | `id`, complete Markdown `body`, `revision` | Replace a fully read note only if its current revision still matches.                                                                                                   |

Read from offset `0`, then follow each `nextOffset`, passing the same `revision` to detect changes between pages. Offsets count JavaScript UTF-16 code units, not bytes or lines; use the returned values rather than computing them. `fullyRead: true` confirms that every part of the current revision has been returned through `notes_read` in this session. A partial or tail-only read cannot authorize replacement. After an update, conflict, session navigation, reload, or compaction, read again before updating. Private viewing and forwarding do not grant update permission.

IDs match `^[a-z0-9][a-z0-9_-]{0,119}$`. Restricting them to lowercase avoids collisions on case-insensitive filesystems. An ID remains stable when its title changes. The first Markdown heading is the title; otherwise the ID is used. Timestamps come from filesystem metadata, not saved history; atomic replacement can reset the displayed creation time.

## Project identity

Project lookup uses local Git configuration only; it never contacts the remote. The first configured origin URL is used, without applying `insteadOf` transport rewrites.

These resolve to the same key:

```text
git@github.com:owner/app.git
ssh://git@github.com:22/owner/app.git
https://github.com:443/owner/app.git/

→ github.com/owner/app
```

Hostnames are lowercased; repository path case is preserved. Credentials are excluded from keys and stored metadata. Nonstandard ports and SSH host aliases remain distinct. Nested GitLab-style namespaces are supported.

The initial version accepts HTTPS, `ssh://`, and scp-style SSH with ASCII hostnames and repository paths. Local/file remotes, HTTP, `git://`, IPv6 hosts, encoded/non-ASCII paths, dot segments, query strings, fragments, and ambiguous URLs are rejected. An existing but invalid or empty origin is an error, not a silent fallback.

Without origin, identity is `git:<real common Git directory>`; outside Git it is `cwd:<real working directory>`. Forks with different origins stay separate. Changing an origin or moving a fallback path does not migrate existing notes.

## Storage and safety

Default location:

```text
~/.pi/agent/project-notes/
  <sha256-of-project-key>/
    project.json
    api-design.md
    api-discussion.md
```

The root follows Pi's agent directory (`getAgentDir()`), including a configured alternative agent directory. `project.json` contains only `{ "key": "..." }`. There is no database, front matter, watcher, or background service. Read-only access does not create storage.

New directories are private (`0700`), and files use `0600`. Invalid IDs, symlinked storage roots/project directories/files, hard-linked files, nonregular files, and mismatched project metadata are rejected. Ancestors above the configured storage root are trusted; this is not a sandbox against a malicious process running as the same OS user.

Writers use an exclusive per-project `.lock` directory, compare revisions inside the lock, and write a synced temporary file before atomic publication. A busy lock fails without writing; retry after the other writer finishes. Independent Pi processes cannot silently overwrite one another's changes. External editors do not participate in the lock: avoid editing a note externally during a Pi save.

Cancellation is checked after queue waits and before publication. Once the final filesystem publication has begun, cancellation cannot roll back a completed save. Terminal controls are removed from the private viewer and escaped in tool/forwarded JSON; the stored Markdown remains unchanged.

### Crash recovery

Locks are **never automatically broken**, even when old. After an interrupted write:

1. Confirm that **all processes writing this project's notes have stopped**.
2. Inspect the exact `.lock` path reported by the error.
3. Remove only that empty `.lock` directory with `rmdir`, then retry.

Do not remove an active writer's lock. Interrupted writes can leave hidden `.tmp-*` files; they are not notes, and are never promoted automatically. If initialization stopped before `project.json` was published, inspect/back up the directory before removing abandoned temporary files; do not fabricate metadata for an unknown populated directory.

## Context and limits

- Startup does not read notes or inject their bodies into model context.
- Tool reads, search excerpts, and **Send to conversation** disclose their returned content to the current model. **Read privately** does not.
- Notes are reference material, not extension/system instructions or proof of the current specification. Current code and user instructions take precedence.
- Notes are external shared data: **forking, branching, or rewinding a Pi conversation never rolls back a save or deletion**.
- There is no automatic save, delete tool, history, backup, cloud sync, origin migration, or GitHub publishing. Back up the storage directory separately.
- Locks coordinate local extension writers; Windows/network filesystems and power-loss durability are not verified. Files are synced, but directory entries are not separately synced.
