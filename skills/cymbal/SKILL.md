---
name: cymbal
description: Search and navigate codebases with the Cymbal CLI. Use for code exploration, symbol lookup, file discovery, outlines, references, importers, call graphs, and change impact. Prefer Cymbal over grep, ripgrep, and find for these tasks.
---

# Cymbal

Use `cymbal` as the first choice for code search and navigation, not `grep`, `rg`, or `find`.

## Setup

- Run commands from the target repository root.
- Check that `cymbal` is available. If missing, explain the limitation and use the fallback tools below; do not install it automatically. On macOS and Linux, the install command is `brew install cymbal`.
- Run `cymbal index .` to initialize an unindexed repository. Queries automatically refresh the index afterward; do not force a full re-index on every search.
- Do not commit generated index files.

## Choose the command

| Question                                                     | Command                             |
| ------------------------------------------------------------ | ----------------------------------- |
| Where should I start in this repository?                     | `cymbal structure`                  |
| Which files are in this repository?                          | `cymbal ls` or `cymbal ls --names`  |
| Where is a symbol defined?                                   | `cymbal search SymbolName`          |
| Where does this text occur?                                  | `cymbal search --text "text"`       |
| What symbols are in this file?                               | `cymbal outline path/to/file.ts -s` |
| Show a symbol's source                                       | `cymbal show SymbolName`            |
| Explain a symbol and its relationships                       | `cymbal investigate SymbolName`     |
| Read source, referenced types, callers, and imports together | `cymbal context SymbolName`         |
| Where is a symbol referenced?                                | `cymbal refs SymbolName`            |
| Which files import this file?                                | `cymbal importers path/to/file.ts`  |
| What does this function call?                                | `cymbal trace SymbolName`           |
| What depends on this function?                               | `cymbal impact SymbolName`          |
| What do the current edits affect?                            | `cymbal changed`                    |

## Workflow

- Search for likely symbol names first. Symbol search ranks exact, prefix, and fuzzy matches; use `search --text` for words in comments, literals, or other file contents.
- Prefer `show`, `investigate`, or `context` over reading whole files just to locate a definition or understand its callers. Read the surrounding file when the task needs more context.
- Narrow ambiguous symbols with a file hint, such as `cymbal show src/auth.ts:login`. For `cymbal search`, use `--path` or `--kind` to narrow results. For `cymbal ls`, pass the path or pattern as a positional argument; `ls` does not accept `--path`.
- Batch independent symbol lookups where supported, for example `cymbal show Foo Bar Baz`. Add `--json` when structured output is useful; otherwise use the compact default output.
- Before modifying shared code, use `impact` and inspect relevant references and importers.
- References and call graphs are best-effort AST/name matches, not compiler-grade resolution. Inspect the source before concluding that two same-named symbols are identical or that there are no other callers.
- Queries federate across worktrees by default. Add `--no-federate` when results must be restricted to the current worktree.

## Examples: narrowing by path

Flags are command-specific; do not assume a flag supported by `search` also works with `ls`.

```bash
# List indexed files under a directory: the path is a positional argument.
cymbal ls --names src/components

# List indexed TypeScript files matching a glob. Quote globs to prevent shell expansion.
cymbal ls --names 'src/components/**/*.ts'

# Search for a symbol within a path, optionally filtering by symbol kind.
cymbal search login --path src/auth --kind function

# Search file contents within a path.
cymbal search --text 'TODO' --path src/components
```

Do not use `cymbal ls --names --path src/components`; it fails with `unknown flag: --path`. If unsure which flags a command accepts, check `cymbal <command> --help`.

## Fallbacks

Use `grep` / `rg` / `find` only when Cymbal is unavailable, fails, or cannot cover the target: unindexed or excluded files, unsupported symbol syntax, filesystem operations outside a repository, or text/regex matching its search cannot express. Prefer `cymbal search --text` and `cymbal ls` before falling back for text search and file discovery. An empty result alone is not proof that a symbol or reference does not exist; check scope and indexing coverage first.

Command reference: https://cymbal.sh/
