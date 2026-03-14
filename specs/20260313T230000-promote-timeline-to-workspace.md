# Promote Timeline to Workspace-Level Content Primitive

**Date**: 2026-03-13
**Status**: In Progress
**Depends on**: `specs/20260313T224500-unify-document-content-model.md` (Phase 1 complete)

## Overview

Move the timeline abstraction from `packages/filesystem` into `packages/workspace` and add a `content` property to `DocumentHandle` that exposes timeline-backed read/write methods. Every app that uses `.withDocument()` gets timeline-backed content access through the handle—no app should need to know about `createTimeline()` or access raw shared types directly.

## Motivation

### Current State

`DocumentHandle` has `read()/write()` methods backed by a raw `Y.Text('content')`. The filesystem package has a separate timeline (`Y.Array('timeline')`) for the same content. Two stores in one Y.Doc:

```typescript
// Workspace handle — reads/writes Y.Text('content')
const handle = await ws.documents.files.content.open(id);
handle.read();        // → Y.Text('content')
handle.write('hi');   // → Y.Text('content')

// Filesystem content helpers — reads/writes Y.Array('timeline')
await fs.content.read(id);      // → timeline
await fs.content.write(id, 'hi'); // → timeline
```

Phase 1 (done) worked around this by switching Opensidian to use `fs.content` directly. But the handle's `read()/write()` still use the wrong store, and the workaround means apps must know to avoid the handle methods—a leaky abstraction.

### Problems

1. **Handle methods are traps**: `handle.read()/write()` exist on the type, look correct, but write to a store nothing else reads.
2. **Timeline is filesystem-private**: Apps that don't use `@epicenter/filesystem` (or custom document types) have no timeline access. They're stuck with raw `Y.Text('content')`.
3. **No editor binding path**: Fuji and Honeycrisp need `Y.Text` or `Y.XmlFragment` for Tiptap binding. They access `handle.ydoc.getText('content')` directly—bypassing both abstractions.

### Desired State

The handle IS the content interface. Timeline is an implementation detail inside the workspace package:

```typescript
const handle = await ws.documents.files.content.open(id);

// Read/write through the standard interface
handle.content.read();         // → reads from timeline
handle.content.write('hello'); // → writes to timeline

// Editor binding through the standard interface
const ytext = handle.content.getText();         // → Y.Text from timeline entry
const fragment = handle.content.getFragment();  // → Y.XmlFragment from timeline entry

// Filesystem delegates to the handle internally
await fs.content.read(id);    // → opens handle, calls handle.content.read()
await fs.content.write(id, 'hello'); // → opens handle, calls handle.content.write()
```

## Research Findings

### Dependency Graph

```
@epicenter/filesystem  ──depends on──►  @epicenter/workspace
@epicenter/workspace   ──zero imports──  @epicenter/filesystem
```

Workspace cannot import from filesystem. Timeline must move into workspace.

### Timeline Dependency Chain

```
timeline.ts (131 lines)
├── yjs                        ← workspace peer dep ✓
├── entry-types.ts (27 lines)  ← pure types, yjs only ✓
└── sheet.ts (CSV helpers)     ← pure functions, depends on:
    ├── yjs ✓
    └── generateColumnId/generateRowId → these are just generateId() from workspace ✓
```

The chain bottoms out at workspace's own exports. No circular dependency risk. Everything can move.

### Current Consumers of handle.read()/write()

| Consumer | Current usage | After this change |
|---|---|---|
| Opensidian `fs-state.svelte.ts` | `fs.content.read/write` (Phase 1 fix) | `handle.content.read/write` or keep fs.content |
| Filesystem `createContentHelpers` | `createTimeline(ydoc)` directly | Delegates to handle.content internally |
| Fuji | `handle.ydoc.getText('content')` | `handle.content.getText()` (Phase 3) |
| Honeycrisp | `handle.ydoc.getXmlFragment('content')` | `handle.content.getFragment()` (Phase 3) |

### What the Filesystem's `createContentHelpers` Does Beyond handle

The filesystem content helpers add capabilities beyond text read/write:

- `write(id, data: string | Uint8Array)` — binary support, mode switching (text→sheet, sheet→text)
- `readBuffer(id)` — binary read
- `append(id, data)` — text append without full replacement
- Sheet-aware write logic (clears and repopulates Y.Maps for CSV data)

These remain filesystem-specific. The handle's `content` provides the foundation; filesystem's content helpers add file-system-level operations on top.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where timeline lives | `packages/workspace/src/content/` | Dependency direction requires it. No circular deps. |
| What moves with it | timeline.ts + entry-types.ts + sheet CSV helpers | Chain bottoms out at workspace exports. Moving everything avoids split implementations. |
| Handle API shape | `handle.content.read()`/`.write()`/`.getText()`/`.getFragment()` | Namespace makes the content contract explicit. Room for future methods. |
| Old `handle.read()/write()` | Removed | No current consumers (Opensidian switched in Phase 1). Dead code with wrong semantics. |
| Filesystem content helpers | Delegate to handle internally | One implementation, one content model. fs.content adds binary/sheet/append on top. |
| Unknown entry types in `readAsString()` | Return `''` | Workspace handle is for text/richtext. Sheet/binary reads go through fs.content. |
| Sheet/binary entry types | Move with timeline, used by filesystem | They're just type definitions and switch cases. Not worth splitting the implementation. |

## Architecture

### Before (dual stores)

```
DocumentHandle
├── ydoc.getText('content')     ← handle.read()/write()
├── ydoc.getArray('timeline')   ← fs.content only
└── handle.ydoc                 ← apps access raw shared types
```

### After (unified)

```
DocumentHandle
├── content.read()/write()      ← timeline-backed, the standard interface
├── content.getText()           ← Y.Text from timeline entry (editor binding)
├── content.getFragment()       ← Y.XmlFragment from timeline entry (richtext binding)
├── content.timeline            ← escape hatch for advanced timeline operations
├── ydoc                        ← escape hatch for truly custom shared types
└── exports                     ← extension exports (unchanged)
```

### Package Layering

```
┌──────────────────────────────────────────────────┐
│  packages/workspace                              │
│  ├── src/content/                                │
│  │   ├── entry-types.ts    (all entry types)     │
│  │   ├── timeline.ts       (createTimeline)      │
│  │   └── sheet-csv.ts      (CSV parse/serialize) │
│  └── src/workspace/                              │
│      ├── create-document.ts (makeHandle → uses   │
│      │                       timeline internally)│
│      └── types.ts           (DocumentHandle with │
│                              content property)   │
└──────────────────────────────────────────────────┘
         ▲
         │ imports from
┌──────────────────────────────────────────────────┐
│  packages/filesystem                             │
│  ├── src/content/                                │
│  │   ├── content.ts  (createContentHelpers —     │
│  │   │                delegates to handle, adds  │
│  │   │                binary/sheet/append)        │
│  │   └── index.ts    (re-exports from workspace) │
│  └── src/formats/                                │
│      └── sheet.ts    (reorder helpers stay here,  │
│                       CSV parse/serialize moved)  │
└──────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Move timeline into workspace

- [x] **1.1** Create `packages/workspace/src/content/entry-types.ts` — move all entry types and `ContentMode` from filesystem
- [x] **1.2** Create `packages/workspace/src/content/sheet-csv.ts` — move `serializeSheetToCsv`, `parseSheetFromCsv`, and helpers from filesystem's `formats/sheet.ts`. Replace `generateColumnId()`/`generateRowId()` with `generateId()`.
- [x] **1.3** Create `packages/workspace/src/content/timeline.ts` — move `createTimeline` from filesystem. Update imports to local entry-types and sheet-csv.
- [x] **1.4** Create `packages/workspace/src/content/index.ts` — export `createTimeline`, `Timeline`, entry types, `ContentMode`, CSV helpers.
- [x] **1.5** Export from `packages/workspace/src/index.ts` — add content module exports.
- [x] **1.6** Update filesystem to re-export from workspace — `packages/filesystem/src/content/` re-exports `createTimeline`, entry types from `@epicenter/workspace`. Delete moved files. Update `formats/sheet.ts` to import CSV helpers from workspace (keep reorder functions local).

### Phase 2: Add `handle.content` to DocumentHandle

- [x] **2.1** Define `DocumentContent` type in `types.ts` — `read()`, `write(text)`, `getText()`, `getFragment()`, `timeline`.
- [x] **2.2** Add `content: DocumentContent` to `DocumentHandle` type. Remove `read()` and `write()` from the type.
- [x] **2.3** Update `makeHandle()` in `create-document.ts` — create timeline from ydoc, wire `content` property.
- [x] **2.4** Migration logic: if `Y.Array('timeline')` is empty but `Y.Text('content')` has data, copy text content into a new timeline text entry on first `content.read()`.

### Phase 3: Update consumers

- [x] **3.1** Update `packages/filesystem/src/content/content.ts` — `createContentHelpers` delegates to handle's content methods internally (opens doc, uses `handle.content.timeline` for advanced operations like binary/sheet mode switching).
- [ ] **3.2** Update Opensidian — can switch back to `handle.content.read()`/`handle.content.write()`, or keep using `fs.content` (both now hit the same store).
  > **Note**: Deferred. Opensidian already works via `fs.content` which now delegates to `handle.content` internally. No functional change needed.
- [x] **3.3** Move timeline test from filesystem to workspace — `timeline.test.ts` moves with the implementation.
- [x] **3.4** All workspace and filesystem tests pass.
- [ ] **3.5** Update documentation — remove anti-pattern warnings from JSDoc, skills, READMEs. `handle.content` is the canonical interface now.
  > **Note**: Deferred to a follow-up. The JSDoc on `DocumentHandle` and `types.ts` has been updated. AGENTS.md and README updates are a separate concern.

## Edge Cases

### Existing Y.Docs with content in Y.Text('content') but no timeline

1. File was created and edited through old `handle.write()` path
2. Timeline is empty, but `getText('content')` has data
3. On first `handle.content.read()`: detect empty timeline + non-empty Y.Text, copy text into a timeline text entry
4. Subsequent reads come from timeline. One-time migration, happens transparently.

### Empty document (no timeline entries, no Y.Text content)

1. `handle.content.read()` → returns `''`
2. `handle.content.write('hello')` → pushes a new text entry to timeline
3. `handle.content.getText()` → returns `undefined` (no entry yet)

### getText() on a non-text entry

1. Current timeline entry is binary or sheet
2. `handle.content.getText()` → returns `undefined`
3. `handle.content.getFragment()` → returns `undefined`
4. For sheet/binary operations, use `fs.content` which understands those types

### Concurrent read during migration

1. Two calls to `handle.content.read()` race during migration
2. Timeline `pushText()` inside `ydoc.transact()` is atomic—second call sees the entry
3. The guard `if timeline empty AND Y.Text has data` prevents double-push

## Open Questions

1. **Should `handle.content.write()` support `Uint8Array`?**
   - Currently text-only. Binary writes go through `fs.content.write()`.
   - **Recommendation**: Keep text-only on the handle. Binary is a filesystem concern.

2. **Should Opensidian switch back to handle.content from fs.content?**
   - Both work. `fs.content` is a thin wrapper. `handle.content` is more direct.
   - **Recommendation**: Switch back—it's cleaner and demonstrates the handle IS the contract.

3. **Should `content.timeline` be exposed on the handle or kept internal?**
   - Exposing it gives advanced users full timeline access (pushSheet, pushBinary, etc.)
   - Hiding it keeps the handle surface minimal
   - **Recommendation**: Expose it. The handle already has `ydoc` as an escape hatch. `timeline` is a more structured alternative.

## Success Criteria

- [ ] `createTimeline` lives in `packages/workspace` and is exported
- [ ] `handle.content.read()` returns content written by `fs.writeFile()` (same store)
- [ ] `fs.readFile()` returns content written by `handle.content.write()` (same store)
- [ ] `handle.content.getText()` returns the timeline entry's `Y.Text` (bindable to Tiptap)
- [ ] Old `handle.read()`/`handle.write()` removed from `DocumentHandle` type
- [ ] Existing Y.Text content migrated on first read (no data loss)
- [ ] All workspace and filesystem tests pass
- [ ] `packages/filesystem` has no local copy of timeline—imports from workspace

## References

- `packages/workspace/src/workspace/create-document.ts` — `makeHandle()` (primary change target)
- `packages/workspace/src/workspace/types.ts` — `DocumentHandle` type definition
- `packages/filesystem/src/content/timeline.ts` — source of `createTimeline()` (moves to workspace)
- `packages/filesystem/src/content/entry-types.ts` — entry type definitions (moves to workspace)
- `packages/filesystem/src/content/content.ts` — `createContentHelpers()` (delegates to handle)
- `packages/filesystem/src/formats/sheet.ts` — CSV helpers (parse/serialize move to workspace)
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — consumer to update
- `specs/20260313T224500-unify-document-content-model.md` — parent spec (Phase 1 complete)
