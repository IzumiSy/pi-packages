# Development

## Setup

```bash
pnpm install
```

## Useful commands

```bash
pnpm dev
pnpm type-check
pnpm test
```

## Extension entry points

Pi loads extensions from `package.json` via `pi.extensions`.


## Project layout

- `extensions/` — extension source code
- `.pi/extensions/` — local re-export shims for loading individual extensions during development
