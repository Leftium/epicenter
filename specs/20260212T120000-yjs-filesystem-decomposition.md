# Decompose YjsFileSystem into FileTree + ContentOps

**Date**: 2026-02-12
**Status**: Draft
**Parent**: `specs/20260208T000000-yjs-filesystem-spec.md`
**See also**: `specs/20260212T000000-async-content-doc-store-with-providers.md`

## Problem

`YjsFileSystem` is a 510-line class with 7 private helper methods that mix two concerns: metadata tree operations (`filesTable` + `index`) and content I/O (`ContentDocStore` + timeline helpers). The private methods can't be tested independently, and constructing a `YjsFileSystem` for any test requires wiring up both concerns even when only one is exercised.

### Private method dependency analysis

Every private method touches either the metadata layer or the content layer, never both (except `softDeleteDescendants` which straddles):

```
Private method          filesTable  index  store  Pure
──────────────────────  ──────────  ─────  ─────  ────
posixResolve(base, p)   no          no     no     YES
resolveId(path)         no          YES    no
getRow(id, path)        YES         no     no
parsePath(path)         no          YES    no
assertDirectory(id, p)  YES         no     no
getActiveChildren(ids)  YES         no     no
softDeleteDescendants   YES         YES    YES    ← straddles
```

Methods 2–6 cluster around `filesTable` + `index`. They're always called together and have zero interaction with content docs. That cluster is a class waiting to be extracted.

### What this blocks

- Can't test tree navigation (path resolution, parent lookups, child filtering) without also constructing a `ContentDocStore`
- Can't test content I/O (read/write/append with timeline mode switching) without also constructing a `TableHelper<FileRow>` and `FileSystemIndex`
- Can't mock the tree to test orchestration logic in isolation
- `softDeleteDescendants` couples tree traversal with content doc destruction; it should be orchestrated at the FS layer, not buried as a private method

---

## Design

### Two new classes, one pure function, one thin adapter

```
  ┌──────────────────────────────────────────────────────┐
  │          YjsFileSystem implements IFileSystem         │
  │                                                      │
  │  Holds: cwd                                          │
  │  Does: posixResolve(cwd, path) then delegates        │
  │  Private helpers: NONE                               │
  │                                                      │
  │  constructor(tree: FileTree, content: ContentOps,    │
  │              cwd: string)                             │
  └──────────┬──────────────────────────┬────────────────┘
             │                          │
  ┌──────────▼──────────┐   ┌──────────▼──────────────┐
  │     FileTree        │   │     ContentOps          │
  │                     │   │                         │
  │ All old privates    │   │ Wraps the ensure →      │
  │ become PUBLIC:      │   │ timeline → transact     │
  │                     │   │ pattern:                │
  │ resolveId(path)     │   │                         │
  │ getRow(id, path)    │   │ read(id) → string       │
  │ parsePath(path)     │   │ readBuffer(id) → u8[]   │
  │ assertDir(id, path) │   │ write(id, data) → size  │
  │ activeChildren(pid) │   │ append(id, data) → size │
  │ descendantIds(id)   │   │ destroy(id)             │
  │                     │   │ destroyAll()            │
  │ Plus tree mutations:│   │                         │
  │ create(...)         │   │ Holds: ContentDocStore  │
  │ softDelete(id)      │   │ Private helpers: NONE   │
  │ move(id, ...)       │   └─────────────────────────┘
  │ touch(id, size)     │
  │ exists(path)        │
  │ allPaths()          │
  │                     │
  │ Holds: filesTable   │
  │        + index      │
  │ Private helpers:    │
  │   NONE              │
  └─────────────────────┘

  + posixResolve()  ← standalone pure function export
```

Every old private method becomes a public method on the right class. No private helpers needed on any of the three classes because the decomposition itself eliminates them.

### FileTree

Owns the metadata table and index. Works exclusively with absolute paths (never sees `cwd`).

```typescript
class FileTree {
  private index: FileSystemIndex & { destroy(): void };

  constructor(private filesTable: TableHelper<FileRow>) {
    this.index = createFileSystemIndex(filesTable);
  }

  resolveId(path: string): FileId | null { /* index lookup, throw ENOENT */ }
  getRow(id: FileId, path: string): FileRow { /* table lookup, throw ENOENT */ }
  parsePath(path: string): { parentId: FileId | null; name: string } { /* split + parent lookup */ }
  assertDirectory(id: FileId | null, path: string): void { /* type check on row */ }
  activeChildren(parentId: FileId | null): FileRow[] { /* filter non-trashed */ }
  descendantIds(parentId: FileId): FileId[] { /* collect active descendant IDs */ }
  exists(path: string): boolean { /* index check */ }
  allPaths(): string[] { /* all indexed paths */ }

  create(opts: { name: string; parentId: FileId | null; type: 'file' | 'folder'; size: number }): FileId { /* validate, insert */ }
  softDelete(id: FileId): void { /* set trashedAt */ }
  move(id: FileId, newParentId: FileId | null, newName: string): void { /* validate, update */ }
  touch(id: FileId, size: number): void { /* update size + updatedAt */ }
  setMtime(id: FileId, mtime: Date): void { /* update updatedAt only */ }

  destroy(): void { this.index.destroy(); }
}
```

`FileTree` creates its own `FileSystemIndex` internally. For testing, you pass in a mock or real `TableHelper`; the index builds itself from whatever the table contains. No need to mock the index separately.

### ContentOps

Wraps the `ensure → timeline → transact` pattern that currently lives inline in every read/write method.

```typescript
class ContentOps {
  private store: ContentDocStore;

  constructor(providers?: ProviderFactory[]) {
    this.store = createContentDocStore(providers);
  }

  async read(fileId: FileId): Promise<string> {
    const ydoc = await this.store.ensure(fileId);
    const entry = getCurrentEntry(getTimeline(ydoc));
    if (!entry) return '';
    return readEntryAsString(entry);
  }

  async readBuffer(fileId: FileId): Promise<Uint8Array> { /* similar */ }

  async write(fileId: FileId, data: string | Uint8Array): Promise<number> {
    const ydoc = await this.store.ensure(fileId);
    const timeline = getTimeline(ydoc);
    const current = getCurrentEntry(timeline);

    if (typeof data === 'string') {
      if (current && getEntryMode(current) === 'text') {
        const ytext = current.get('content') as Y.Text;
        ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, data); });
      } else {
        ydoc.transact(() => pushTextEntry(timeline, data));
      }
      return new TextEncoder().encode(data).byteLength;
    } else {
      ydoc.transact(() => pushBinaryEntry(timeline, data));
      return data.byteLength;
    }
  }

  async append(fileId: FileId, data: string): Promise<number> { /* mode-aware append */ }
  async destroy(fileId: FileId): Promise<void> { return this.store.destroy(fileId); }
  async destroyAll(): Promise<void> { return this.store.destroyAll(); }
}
```

All timeline-specific logic (mode switching, in-place text editing vs pushing new entries) is encapsulated here. The FS layer just says "write this data" and `ContentOps` figures out how.

### YjsFileSystem becomes a thin orchestrator

Every IFileSystem method reduces to ~3–6 lines: apply `cwd`, call tree, call content.

```typescript
class YjsFileSystem implements IFileSystem {
  constructor(
    private tree: FileTree,
    private content: ContentOps,
    private cwd: string = '/',
  ) {}

  static create(
    filesTable: TableHelper<FileRow>,
    cwd?: string,
    options?: { providers?: ProviderFactory[] },
  ): YjsFileSystem {
    const tree = new FileTree(filesTable);
    const content = new ContentOps(options?.providers);
    return new YjsFileSystem(tree, content, cwd);
  }

  async readFile(path: string): Promise<string> {
    const abs = posixResolve(this.cwd, path);
    const id = this.tree.resolveId(abs)!;
    const row = this.tree.getRow(id, abs);
    if (row.type === 'folder') throw fsError('EISDIR', abs);
    return this.content.read(id);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const abs = posixResolve(this.cwd, path);
    // ... resolve, check children ...
    this.tree.softDelete(id);
    await this.content.destroy(id);
    if (row.type === 'folder' && options?.recursive) {
      for (const did of this.tree.descendantIds(id)) {
        this.tree.softDelete(did);
        await this.content.destroy(did);
      }
    }
  }
  // ...
}
```

`softDeleteDescendants` dissolves: `tree.descendantIds(id)` returns the IDs, the FS layer orchestrates both `tree.softDelete` and `content.destroy` for each. No cross-cutting private method needed.

### posixResolve becomes a standalone export

Already a static method with zero instance state. Extract to a plain function in a `path-utils.ts` file (or co-locate in `validation.ts`).

```typescript
/** Resolve a POSIX path: absolute paths used as-is, relative joined onto base, `.`/`..` normalized. */
export function posixResolve(base: string, path: string): string { /* ... */ }
```

---

## Construction / DI

```
Production:
  filesTable ──→ new FileTree(filesTable)    ──┐
                                                ├──→ new YjsFileSystem(tree, content, cwd)
  providers  ──→ new ContentOps(providers)   ──┘

  // Or use the convenience factory:
  YjsFileSystem.create(filesTable, '/', { providers: [idbProvider] })
```

```
Testing FileTree alone:
  const tree = new FileTree(mockTable);
  tree.resolveId('/foo/bar');
  tree.activeChildren(someParentId);
  tree.create({ name: 'x', parentId: null, type: 'file', size: 0 });

Testing ContentOps alone:
  const content = new ContentOps();  // no providers = instant
  await content.write(id, 'hello');
  expect(await content.read(id)).toBe('hello');

Testing YjsFileSystem orchestration:
  const fs = new YjsFileSystem(mockTree, mockContent, '/');
  await fs.readFile('/test.txt');
  // verify mockTree.resolveId called, mockContent.read called
```

---

## Implementation Plan

### Phase 1: Extract posixResolve + FileTree

- [ ] **1.1** Export `posixResolve` as a standalone function (new `path-utils.ts` or in `validation.ts`)
- [ ] **1.2** Create `FileTree` class in `file-tree.ts` absorbing: `resolveId`, `getRow`, `parsePath`, `assertDirectory`, `getActiveChildren` → `activeChildren`, `softDeleteDescendants` → `descendantIds` (returns IDs only)
- [ ] **1.3** Add tree mutation methods: `create`, `softDelete`, `move`, `touch`, `setMtime`
- [ ] **1.4** Add `exists(path)` and `allPaths()` (moved from YjsFileSystem)
- [ ] **1.5** Write `file-tree.test.ts`: test path resolution, row lookups, child filtering, descendant collection, create/delete/move without any content docs

### Phase 2: Extract ContentOps

- [ ] **2.1** Create `ContentOps` class in `content-ops.ts` absorbing the ensure → timeline → transact pattern from `readFile`, `readFileBuffer`, `writeFile`, `appendFile`
- [ ] **2.2** `write()` returns byte size (so FS layer can call `tree.touch` without recomputing)
- [ ] **2.3** `append()` returns byte size
- [ ] **2.4** Write `content-ops.test.ts`: test read/write/append, mode switching (text → binary → text), empty file reads

### Phase 3: Rewrite YjsFileSystem as thin orchestrator

- [ ] **3.1** Change constructor to accept `(tree: FileTree, content: ContentOps, cwd: string)`
- [ ] **3.2** Add `static create(filesTable, cwd?, options?)` convenience factory for backward compatibility
- [ ] **3.3** Rewrite every IFileSystem method to delegate to `tree` + `content`
- [ ] **3.4** Remove all private helpers (they now live on `FileTree` or `ContentOps`)
- [ ] **3.5** Existing `yjs-file-system.test.ts` should pass unchanged (behavior is identical)

### Phase 4: Update tests

- [ ] **4.1** Add orchestration-level tests: mock `FileTree` and `ContentOps`, verify `YjsFileSystem` calls them correctly
- [ ] **4.2** Verify existing integration tests still pass with `YjsFileSystem.create()`

---

## Edge Cases

### writeFile creating a new file

`writeFile` both creates metadata (via `tree.create`) and writes content (via `content.write`). This is orchestration that belongs in the FS layer:

1. Check if path exists via `tree.exists()`
2. If not: `tree.create({ name, parentId, type: 'file', size })`
3. `const size = await content.write(id, data)`
4. `tree.touch(id, size)`

### cp reads content + creates structure

`cp` calls both `tree` (mkdir, resolve) and `content` (read source, write dest). Same pattern: orchestration in the FS layer, not in either sub-service.

### appendFile falls back to writeFile

When the file doesn't exist, `appendFile` delegates to `writeFile`. This remains orchestration in the FS layer.

---

## Open Questions

1. **Should `FileTree` expose the raw index?**
   - Currently `readdir` accesses `this.index.childrenOf` directly. After extraction, `activeChildren(parentId)` replaces that. But `writeFile` also calls `assertUniqueName(this.filesTable, this.index.childrenOf, ...)` for the EEXIST check.
   - Options: (a) `FileTree` exposes `assertUniqueName` as a method, (b) `FileTree` exposes the index for direct access, (c) `create()` handles validation internally
   - **Recommendation**: Option (c). `FileTree.create()` validates name + uniqueness internally. Callers don't need to know about the index.

2. **Class vs factory function for FileTree and ContentOps?**
   - The user requested classes for consistency with the current `YjsFileSystem` class.
   - **Recommendation**: Classes. Consistent with existing code, straightforward DI via constructor.

3. **Should `disambiguateNames` move into FileTree?**
   - Currently called in `readdir` and `readdirWithFileTypes` with the result of `activeChildren`. Could become a method on FileTree: `displayChildren(parentId)` returning rows with display names.
   - **Recommendation**: Keep `disambiguateNames` as a standalone function in `validation.ts`. FileTree's `activeChildren` returns raw rows; the FS layer applies disambiguation. Keeps FileTree focused on tree structure.

---

## Success Criteria

- [ ] `FileTree` is independently constructable and testable with only a `TableHelper<FileRow>`
- [ ] `ContentOps` is independently constructable and testable with no table/index
- [ ] `YjsFileSystem` has zero private helper methods
- [ ] `YjsFileSystem.create()` provides backward-compatible construction
- [ ] All existing tests in `yjs-file-system.test.ts` pass without modification
- [ ] New tests cover FileTree and ContentOps in isolation

## References

- `packages/epicenter/src/filesystem/yjs-file-system.ts` — Current monolithic class (to be rewritten)
- `packages/epicenter/src/filesystem/file-system-index.ts` — Already extracted; FileTree wraps this
- `packages/epicenter/src/filesystem/content-doc-store.ts` — Already extracted; ContentOps wraps this
- `packages/epicenter/src/filesystem/timeline-helpers.ts` — Pure functions used by ContentOps
- `packages/epicenter/src/filesystem/validation.ts` — Standalone validation; stays as-is
- `packages/epicenter/src/filesystem/types.ts` — Shared types (FileId, FileRow, etc.)
