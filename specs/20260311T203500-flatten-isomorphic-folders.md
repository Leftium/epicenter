# Flatten `isomorphic/` Folders in Query and Services Layers

## Problem

Both `lib/query/` and `lib/services/` contain an `isomorphic/` subfolder that holds ~90% of
the code. The name "isomorphic" is a misnomer (traditionally means server+client; this app is
fully client-side) and the nesting inverts the default—the majority case lives in a subfolder
while the 10% exception (`desktop/`) sits alongside it.

## Solution

Flatten `isomorphic/` contents to their parent directory. `desktop/` stays nested as the exception.

### Before

```
query/
├── index.ts          → re-exports from ./isomorphic and ./desktop
├── isomorphic/       → 13 files (the 90%)
│   └── index.ts      → creates `rpc` namespace
└── desktop/          → 5 files (the 10%)

services/
├── index.ts          → re-exports from ./isomorphic and ./desktop
├── isomorphic/       → 80+ files across 14 subdirectories
│   └── index.ts      → creates `services` namespace
└── desktop/          → 9 files
```

### After

```
query/
├── index.ts          → creates `rpc` namespace + re-exports desktopRpc
├── actions.ts
├── analytics.ts
├── ...               → all domain files at root
└── desktop/          → unchanged

services/
├── index.ts          → creates `services` namespace + re-exports desktopServices
├── analytics/
├── completion/
├── db/
├── ...               → all domain dirs/files at root
└── desktop/          → unchanged
```

## Execution Plan

### Wave 1: Flatten query layer
- [x] `git mv` all non-index files from `query/isomorphic/` to `query/`
- [x] Merge `query/isomorphic/index.ts` barrel into `query/index.ts`
- [x] Delete `query/isomorphic/`
- [x] Typecheck passes

### Wave 2: Flatten services layer
- [x] `git mv` all non-index files/dirs from `services/isomorphic/` to `services/`
- [x] Merge `services/isomorphic/index.ts` barrel into `services/index.ts`
- [x] Delete `services/isomorphic/`
- [x] Bulk replace `$lib/services/isomorphic/` → `$lib/services/` in all files
- [x] Typecheck passes

### Wave 3: Verify + format
- [x] `bun typecheck`
- [x] `bun format`

## Import Changes

| Old path | New path |
|---|---|
| `$lib/services/isomorphic/...` | `$lib/services/...` |
| `$lib/query/isomorphic` | `$lib/query` |
| `./isomorphic` (in barrel files) | Direct imports from `./` |

## Review

(To be filled after implementation)
