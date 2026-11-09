---
name: code-search
description: Search and navigate codebases with Cymbal, FFF, and shell fallbacks. Use for code exploration, symbol lookup, file discovery, outlines, references, importers, call graphs, and change impact. Prefer Cymbal first, FFF tools (fffind/ffgrep) second, and rg/grep/find last.
---

# Code Search

For code search and navigation, prefer `cymbal` → FFF tools (`fffind` / `ffgrep`) → `rg` / `grep` / `find`. Use the first available tool that covers the task; this is a preference order, not a requirement to repeat every search with all three.

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

1. **Cymbal first.** Prefer `cymbal search --text` for content and `cymbal ls` for file discovery, as well as the semantic commands above. Fall back when Cymbal is unavailable, fails, or cannot cover the target: excluded files, unsupported syntax, paths outside its index, or matching its search cannot express.
2. **FFF second.** If the `@ff-labs/pi-fff` tools are available, use `fffind` for fuzzy path/glob search and `ffgrep` for content/text/regex search before shell search commands. FFF also supports paths outside the workspace; do not skip it merely because a target is outside the repository. Use the tools' advertised names and schemas; in FFF override mode they may be named `find` / `grep` instead.
3. **Shell search last.** Use `rg` / `grep` / `find` only when both Cymbal and FFF are unavailable, fail, or cannot cover the required scope or matching behavior. Ordinary filesystem operations are outside this search preference order.

An empty result alone is not proof that a file, symbol, or reference does not exist. Check path filters, exclusions, indexing coverage, and pagination before broadening the query or switching tools. FFF and shell text matches do not replace semantic references or call graphs; inspect the source when Cymbal cannot resolve them.

For FFF, keep file queries to 1–2 terms, use `path` for scope and `exclude` for noise, and prefer bare identifiers for content search. Follow returned cursors when more results are needed, then read the relevant files rather than repeating searches. Neither fallback requires automatic installation.

Command reference: https://cymbal.sh/
