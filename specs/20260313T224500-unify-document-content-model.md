# Unify Document Content Model

**Date**: 2026-03-13
**Status**: Draft

## Overview

Document Y.Docs store content through two independent, incompatible models—a timeline array and a raw Y.Text. Writes through one path are invisible to reads through the other. This spec proposes unifying on the timeline model as the single content abstraction.

## Motivation

### Current State

Every table with `.withDocument()` gets a content Y.Doc per row. That Y.Doc can be accessed two ways:

**Path 1: Timeline model** (packages/filesystem)

```typescript
// packages/filesystem/src/content/timeline.ts
const timeline = ydoc.getArray<Y.Map>('timeline');
// Each entry: { type: 'text'|'binary'|'sheet', content: Y.Text|Uint8Array|... }

// packages/filesystem/src/content/content.ts
const { ydoc } = await documents.open(fileId);
const tl = createTimeline(ydoc);
tl.readAsString();          // reads timeline[last].content
tl.pushText('hello');       // appends new timeline entry
```

**Path 2: Handle model** (packages/workspace)

```typescript
// packages/workspace/src/workspace/create-document.ts — makeHandle()
read()  { return ydoc.getText('content').toString(); }
write(text) {
    const ytext = ydoc.getText('content');
    ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, text); });
}
```

These write to completely different Y.js shared types within the same Y.Doc:

```
Document Y.Doc (guid: fileId)
├── Y.Array('timeline')           ← filesystem API writes here
│   └── [0]: Y.Map { type: 'text', content: Y.Text('hello') }
├── Y.Text('content')             ← handle.read/write uses here
└── (both persisted to IndexedDB, but never synchronized)
```

This creates problems:

1. **Silent data loss**: `fs.writeFile('/readme.md', 'hello')` writes to timeline. `handle.read()` reads from raw Y.Text. Returns `''`. Content exists but is invisible to the editor.
2. **Confusing API surface**: `DocumentHandle` exposes `read()/write()` as the "obvious" way to use documents, but these methods use a different storage model than the filesystem that created the content.
3. **No single source of truth**: Two independent content stores in the same Y.Doc means no authoritative read path.

### Current App Usage

| App | Content Access Pattern | Model Used |
|---|---|---|
| Opensidian | `handle.read()/write()` in ContentEditor | Handle (raw Y.Text) |
| Opensidian | `fs.writeFile()`/`fs.readFile()` for file creation | Timeline |
| Honeycrisp | `handle.ydoc.getXmlFragment('content')` directly | Neither—raw Y.Doc access |
| Fuji | `handle.ydoc.getText('content')` directly | Neither—raw Y.Doc access |

Honeycrisp and Fuji bypass `handle.read()/write()` entirely. They use the handle only for Y.Doc access and work with shared types directly. Opensidian is the only app using both paths on the same Y.Doc.

### Desired State

One content model. Timeline wins because it supports multiple formats (text, binary, sheet) and already powers the filesystem API. The handle's `read()/write()` should read from the timeline, not a separate raw Y.Text.

## Research Findings

### Why Timeline Exists

The timeline model was introduced for the filesystem package to support multi-format content: plain text files, binary blobs, and CSV sheets. Each "entry" in the timeline is a typed Y.Map with a mode discriminator. The most recent entry is the current content.

See: `packages/filesystem/src/content/entry-types.ts`, `packages/filesystem/src/content/timeline.ts`

### Why Handle Uses Raw Y.Text

`makeHandle()` in `create-document.ts` was built as a generic convenience for the workspace package. It uses `ydoc.getText('content')` because that's the simplest Y.js pattern for text content. It was designed before the filesystem/timeline model existed, or without awareness of it.

### Who Actually Calls handle.read()/write()

Only Opensidian's `readContent`/`writeContent` in `fs-state.svelte.ts`. Honeycrisp and Fuji use the `ydoc` property directly.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Which content model wins | Timeline | Supports text/binary/sheet. Already powers filesystem. More capable. |
| Where to make the change | `makeHandle()` in create-document.ts | Single change point. All consumers automatically use timeline. |
| What about apps using ydoc directly | No change needed | Honeycrisp/Fuji access the Y.Doc directly. handle.read()/write() changes don't affect them. |
| What about handle.ydoc escape hatch | Keep it | Apps that need raw Y.Doc access (XmlFragment, custom types) still have it. |
| Timeline dependency direction | Deferred | Timeline currently lives in packages/filesystem. Moving it to packages/workspace or extracting a shared module is an open question. |

## Architecture

### Before (two content stores)

```
Document Y.Doc
├── Y.Array('timeline')     ← fs.writeFile/readFile
│   └── entries[]
├── Y.Text('content')       ← handle.read/write
└── (disconnected)
```

### After (single content store)

```
Document Y.Doc
├── Y.Array('timeline')     ← BOTH filesystem AND handle
│   └── entries[]
├── Y.Text('content')       ← unused (legacy, could be removed)
└── handle.read() → timeline[last].readAsString()
    handle.write() → timeline[last] text replace OR pushText
```

## Implementation Plan

### Phase 1: Make handle.read()/write() use timeline

- [ ] **1.1** Move or re-export `createTimeline` so it's accessible from `packages/workspace` without importing `packages/filesystem`. Options: (a) extract timeline into a shared util in workspace, (b) import filesystem from workspace (inverts dependency), (c) inline minimal timeline logic in makeHandle.
- [ ] **1.2** Change `makeHandle()` in `create-document.ts`: `read()` calls `createTimeline(ydoc).readAsString()`, `write(text)` checks `currentMode` — if text, replaces in-place; if no timeline entry, calls `pushText()`.
- [ ] **1.3** Update `DocumentHandle` type JSDoc to reflect timeline-backed behavior.
- [ ] **1.4** Update Opensidian's `readContent`/`writeContent` — these can now use `handle.read()/write()` and get timeline behavior, OR switch to `fs.content.read()`/`fs.content.write()` directly if we decide handle shouldn't exist.

### Phase 2: Clean up raw Y.Text usage

- [ ] **2.1** Audit all apps for `ydoc.getText('content')` usage — migrate to timeline or leave as direct Y.Doc access.
- [ ] **2.2** Consider whether `handle.read()/write()` should exist at all, or if the handle should only expose `ydoc` + `exports`.
- [ ] **2.3** Handle migration for existing persisted Y.Docs that have content in `Y.Text('content')` but not in `Y.Array('timeline')` (or vice versa).

## Edge Cases

### Existing persisted Y.Docs with raw Y.Text content

1. User saved content via old handle.write() → data in `ydoc.getText('content')`
2. Code is updated → handle.read() now reads from timeline → returns '' (timeline is empty)
3. **Need migration**: on first read, if timeline is empty but `getText('content')` has data, copy it into a timeline entry.

### Empty document (no timeline entries)

1. Brand new file, timeline is empty, `currentMode === undefined`
2. `handle.read()` → `readAsString()` returns `''` (correct)
3. `handle.write('hello')` → needs to `pushText('hello')` to create the first entry

### Binary/sheet content read as text

1. File was written as binary via `fs.writeFile(path, buffer)`
2. `handle.read()` → `readAsString()` would decode binary as text
3. This is the current timeline behavior (returns decoded text) — acceptable.

## Open Questions

1. **Where should timeline live?**
   - Currently in `packages/filesystem/src/content/timeline.ts`
   - `packages/workspace` can't import from `packages/filesystem` (wrong dependency direction)
   - Options: (a) Extract timeline into workspace as a shared primitive, (b) Create a shared `packages/content` package, (c) Inline minimal read/write logic in makeHandle without full timeline
   - **Recommendation**: Option (a) — timeline is simple enough (~130 lines) to live in workspace. The filesystem package would then import it from workspace.

2. **Should handle.read()/write() even exist?**
   - Honeycrisp and Fuji don't use them. They work with the Y.Doc directly.
   - handle.read()/write() are only convenient for plain text. Rich text, sheets, binary all need direct Y.Doc access.
   - **Recommendation**: Keep them as a convenience for the common case (plain text), but document that they're a thin wrapper over timeline.

3. **What about the `onUpdate` callback?**
   - Currently, `create-document.ts` watches the Y.Doc 'update' event and calls `onUpdate()` to bump `updatedAt`.
   - This fires on ANY Y.Doc change, so it works regardless of content model.
   - **No change needed** — but worth verifying.

## Success Criteria

- [ ] `handle.read()` returns content written by `fs.writeFile()` (same Y.Doc, same shared type)
- [ ] `fs.readFile()` returns content written by `handle.write()` (same Y.Doc, same shared type)
- [ ] Existing persisted content (in raw Y.Text) is migrated on first read
- [ ] All workspace/filesystem tests pass
- [ ] Opensidian: create file → type content → switch files → switch back → content is there

## References

- `packages/workspace/src/workspace/create-document.ts` — `makeHandle()` (line 101-120)
- `packages/workspace/src/workspace/types.ts` — `DocumentHandle` type (line 255-278)
- `packages/filesystem/src/content/timeline.ts` — Timeline abstraction
- `packages/filesystem/src/content/content.ts` — `createContentHelpers()` (uses timeline)
- `packages/filesystem/src/file-system.ts` — `createYjsFileSystem()` (uses content helpers)
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — `readContent`/`writeContent` (uses handle)
- `apps/opensidian/src/lib/components/ContentEditor.svelte` — Editor component
- `specs/20260313T000200-three-tier-extension-api.md` — Related persistence fix
