# Package Renaming (Revised)

**Date**: 2026-02-24 (original), 2026-03-10 (revised)
**Status**: Partially Complete
**Author**: AI-assisted

## Overview

Finish the partially-completed package renaming effort: align the `packages/epicenter/` directory with its npm name `@epicenter/workspace`, drop the phantom `-core` suffix from `vault-core`, and delete the dead `shared` package.

## Motivation

### Current State

The monorepo has 16 packages under `packages/`:

```
@epicenter/workspace    → packages/epicenter/              ← DIRECTORY MISMATCH
@epicenter/ai           → packages/ai/                     ✓
@epicenter/cli          → packages/cli/                    ✓
@epicenter/config       → packages/config/                 ✓
@epicenter/constants    → packages/constants/              ✓
@epicenter/filesystem   → packages/filesystem/             ✓
@epicenter/server       → packages/server/                 ✓
@epicenter/server-local → packages/server-local/           ✓
@epicenter/server-remote-cloudflare → packages/server-remote-cloudflare/ ✓
@epicenter/shared       → packages/shared/                 ← DEAD PACKAGE
@epicenter/svelte-utils → packages/svelte-utils/           ✓
@epicenter/sync         → packages/sync/                   ✓
@epicenter/sync-client  → packages/sync-client/            ✓
@epicenter/sync-server  → packages/sync-server/            ✓
@epicenter/ui           → packages/ui/                     ✓
@epicenter/vault-core   → packages/vault-core/             ← PHANTOM SUFFIX
```

Three problems remain:

1. **Directory/name mismatch on workspace.** The npm name was already renamed from `@epicenter/hq` to `@epicenter/workspace`, but the directory is still `packages/epicenter/`. A contributor reading `bun.lock` sees `@epicenter/workspace` and has to figure out it lives in `packages/epicenter/`.

2. **`@epicenter/shared` is dead.** It exports exactly one function (`safeLookup`) that has zero imports anywhere in the codebase. Its description still says "Shared constants for Whispering web app, desktop app, and Chrome extension." Only `apps/whispering/package.json` lists it as a dependency, but nothing actually imports from it.

3. **`@epicenter/vault-core` has a phantom parent.** The `-core` suffix implies there's a `@epicenter/vault` package. There isn't.

### What Was Already Completed (from the original spec)

- npm name `@epicenter/hq` → `@epicenter/workspace` (done — `package.json` updated)
- All `@epicenter/hq` import references replaced with `@epicenter/workspace` across the codebase (done — zero remaining references in `.ts` or `.json` files)
- All `package.json` dependency references updated (done)
- Server restructure (done differently than proposed — split into `server/`, `server-local/`, `server-remote-cloudflare/` instead of keeping as one package)

### Desired State

```
packages/
├── workspace/       ← npm: @epicenter/workspace  ★ DIRECTORY RENAMED
├── vault/           ← npm: @epicenter/vault       ★ RENAMED
├── ai/              ← @epicenter/ai
├── cli/             ← @epicenter/cli
├── config/          ← @epicenter/config
├── constants/       ← @epicenter/constants
├── filesystem/      ← @epicenter/filesystem
├── server/          ← @epicenter/server
├── server-local/    ← @epicenter/server-local
├── server-remote-cloudflare/ ← @epicenter/server-remote-cloudflare
├── svelte-utils/    ← @epicenter/svelte-utils
├── sync/            ← @epicenter/sync
├── sync-client/     ← @epicenter/sync-client
├── sync-server/     ← @epicenter/sync-server
└── ui/              ← @epicenter/ui
                                                   ★ shared/ DELETED
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Rename dir `packages/epicenter/` → `packages/workspace/` | Do it | Directory should match npm name. The npm name is already `@epicenter/workspace`. |
| Keep npm name `@epicenter/workspace` | Keep | Every export is workspace-related (`defineWorkspace`, `createClient`). Considered `core`, `sdk`, `client`, `data` — all worse. "Workspace" IS the core domain abstraction. |
| Singular `workspace` not `workspaces` | Singular | Package naming convention is singular (`@prisma/client`, `drizzle-orm`). |
| Delete `@epicenter/shared` entirely | Delete | Zero imports in the entire codebase. The only export (`safeLookup`) is unused dead code. Not worth merging into `constants` — just delete it. |
| Rename `@epicenter/vault-core` → `@epicenter/vault` | Do it | Drop phantom `-core` suffix. No parent `@epicenter/vault` package exists. |
| Drop Phase 4 (server docs) from original spec | Drop | The server was already restructured into separate packages (`server/`, `server-local/`, `server-remote-cloudflare/`), which resolved the original concern about conflated responsibilities. |

## Implementation Plan

### Phase 1: Rename directory `packages/epicenter/` → `packages/workspace/`

The npm name is already correct. This is purely a directory rename + reference updates.

**Impact audit — references to `packages/epicenter` in the codebase:**
- `AGENTS.md` line 5 (root) — mentions `packages/epicenter/`
- `packages/epicenter/AGENTS.md` — will move with the directory

No references in: `turbo.json`, `tsconfig` files, `biome.jsonc`, any `package.json`.

- [ ] **1.1** Rename directory: `mv packages/epicenter packages/workspace`
- [ ] **1.2** Update root `AGENTS.md`: change `packages/epicenter/` → `packages/workspace/`
- [ ] **1.3** Run `bun install` to update lockfile with new directory path
- [ ] **1.4** Verify: `bun run typecheck` passes (or only pre-existing errors)
- [ ] **1.5** Verify: `bun test` passes in `packages/workspace/` (or only pre-existing failures)

### Phase 2: Rename `@epicenter/vault-core` → `@epicenter/vault`

**Impact audit — all references:**

TypeScript imports (19 across 10 files):
- `apps/vault-demo/src/routes/api/vault/ingest/+server.ts` — 4 imports
- `apps/vault-demo/src/lib/remote/vault.remote.ts` — 1 import
- `apps/vault-demo/src/lib/export/index.ts` — 1 import
- `apps/vault-demo/src/lib/server/vaultService.ts` — 5 imports
- `apps/demo-mcp/src/cli.ts` — 3 imports
- `packages/vault-core/src/adapters/entity-index/src/adapter.ts` — 1 import
- `packages/vault-core/src/adapters/reddit/src/ingestor.ts` — 1 import
- `packages/vault-core/src/adapters/reddit/src/metadata.ts` — 1 import
- `packages/vault-core/src/adapters/reddit/src/adapter.ts` — 1 import
- `packages/vault-core/src/adapters/example-notes/src/adapter.ts` — 1 import

JSON/config references (4 files):
- `packages/vault-core/package.json` — name field
- `apps/vault-demo/package.json` — dependency
- `apps/demo-mcp/package.json` — dependency
- `apps/demo-mcp/tsconfig.json` — path mapping

- [ ] **2.1** Rename directory: `mv packages/vault-core packages/vault`
- [ ] **2.2** Update `packages/vault/package.json`: name `@epicenter/vault-core` → `@epicenter/vault`
- [ ] **2.3** Find-and-replace all TypeScript imports: `@epicenter/vault-core` → `@epicenter/vault` (19 imports across 10 files listed above, including subpath imports like `/codecs`, `/adapters/*`, `/utils/*`)
- [ ] **2.4** Update `apps/vault-demo/package.json`: dependency `@epicenter/vault-core` → `@epicenter/vault`
- [ ] **2.5** Update `apps/demo-mcp/package.json`: dependency `@epicenter/vault-core` → `@epicenter/vault`
- [ ] **2.6** Update `apps/demo-mcp/tsconfig.json`: path `@epicenter/vault-core` → `@epicenter/vault`, directory `packages/vault-core` → `packages/vault`
- [ ] **2.7** Update `packages/vault/README.md`: any `@epicenter/vault-core` or `packages/vault-core` references
- [ ] **2.8** Run `bun install` to update lockfile
- [ ] **2.9** Verify: `bun run typecheck` passes (or only pre-existing errors)

### Phase 3: Delete `@epicenter/shared`

**Impact audit — all references:**
- `packages/shared/package.json` — the package itself
- `apps/whispering/package.json` — lists as dependency (but nothing imports from it)
- Zero TypeScript imports anywhere in the codebase

- [ ] **3.1** Remove `@epicenter/shared` from `apps/whispering/package.json` dependencies
- [ ] **3.2** Delete `packages/shared/` directory entirely
- [ ] **3.3** Run `bun install` to update lockfile
- [ ] **3.4** Verify: `bun run typecheck` passes (or only pre-existing errors)

## Edge Cases

### Workspace ID Strings

The workspace ID convention is `epicenter.<app>` (e.g., `epicenter.whispering`). These are runtime data strings, NOT package import paths. Unaffected by the directory rename.

### Git History

Renaming `packages/epicenter/` → `packages/workspace/` will break `git log -- packages/epicenter/` unless `--follow` is used. Standard git behavior, acceptable.

### `bun link` Users

Anyone who previously ran `bun link` in `packages/epicenter/` will need to re-link from `packages/workspace/`.

## Success Criteria

- [ ] `packages/workspace/` directory name matches npm name `@epicenter/workspace`
- [ ] `packages/epicenter/` no longer exists
- [ ] `@epicenter/vault-core` no longer exists — all references are `@epicenter/vault`
- [ ] `packages/vault/` directory name matches npm name `@epicenter/vault`
- [ ] `packages/vault-core/` no longer exists
- [ ] `packages/shared/` no longer exists
- [ ] `bun install` succeeds from clean state
- [ ] `bun run typecheck` passes (or pre-existing errors only)
- [ ] No remaining string literals `@epicenter/vault-core` or `@epicenter/shared` in source code (excluding specs)
- [ ] Root `AGENTS.md` references `packages/workspace/`

## References

- `packages/epicenter/package.json` — already has name `@epicenter/workspace` (directory rename only)
- `packages/vault-core/package.json` — current `@epicenter/vault-core` definition
- `packages/shared/package.json` — dead package to delete
- `AGENTS.md` — references `packages/epicenter/`
- `apps/demo-mcp/tsconfig.json` — has vault-core path mapping
