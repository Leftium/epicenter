# Build CRDT File Systems from Flat Tables, Not Nested Trees

**TL;DR: Most Yjs multi-file editors converge on flat metadata with parent pointers plus one Y.Doc per file. At Epicenter, we push this further with YKeyValueLww (1935x smaller than Y.Map) for the file tree, gc: true on metadata to keep storage tiny, and gc: false on content docs so every file has full revision history.**

> Flatten your hierarchy into rows with parent pointers. Compute paths at runtime. Store content in separate documents. Then pick the right CRDT primitive and GC strategy for each layer.

## The general pattern

Every serious Yjs-based multi-file editor ends up in the same place. You need a file tree and you need editable content per file. Putting everything in one Y.Doc doesn't scale: 500 files at 10KB each is 5MB loaded eagerly, with no way to lazy-load individual files.

So you split into two layers. A metadata doc holds the file tree structure. Separate content docs hold the actual editable text, loaded on demand when the user opens a file. This is the same split Google Drive uses between file metadata and document content.

The file tree is almost always a flat table with parent pointers, not nested CRDTs. Each row has an opaque ID, a `name`, a `parentId`, and a `type`. Nesting Y.Maps for directories sounds natural but falls apart when moving files between folders creates concurrent edit windows. Parent pointers make moves a single field update with no deletion-reinsertion hazards. Paths like `/src/index.ts` are computed at runtime by walking the `parentId` chain.

```
File tree (flat table, always loaded):
┌───────────┬──────────┬──────────┬────────┐
│ id        │ name     │ parentId │ type   │
├───────────┼──────────┼──────────┼────────┤
│ mR4j9     │ src      │ null     │ folder │
│ x7kQ2     │ index.ts │ mR4j9   │ file   │
│ pL8n3     │ api.md   │ mR4j9   │ file   │
└───────────┴──────────┴──────────┴────────┘

Content docs (one per file, loaded on demand):
  Y.Doc(guid: 'x7kQ2') → Y.Text for index.ts
  Y.Doc(guid: 'pL8n3') → Y.XmlFragment for api.md
```

IDs are opaque (nanoids or UUIDs), never paths. A file's ID doubles as its content doc's GUID, creating a clean 1:1 mapping. Renames update `name`. Moves update `parentId`. The ID and the content doc's GUID never change.

Most implementations also choose separate top-level Y.Docs over Yjs subdocuments for content. Subdocs provide lifecycle management and parent-doc enumeration, but almost no provider actually supports them: y-websocket, y-indexeddb, y-sweet, and Hocuspocus all don't. AFFiNE went the subdoc route and had to build a complete custom provider stack. With separate docs, every provider already knows how to sync a Y.Doc by GUID, and your file table already enumerates every content doc GUID.

That's the common ground. Where implementations diverge is in the CRDT data structures they use for the file tree, how they handle garbage collection, and what goes inside each content doc. This is where Epicenter's choices get specific.

## How Epicenter models the file tree

Most Yjs apps store key-value data in a Y.Map. For a file tree where rows get updated frequently (renames, moves, size changes, timestamps), Y.Map is quietly catastrophic. It retains every historical value for every key. Rename a file 100 times and Y.Map stores all 100 previous values internally, forever. For a file tree that changes constantly, storage grows without bound.

At Epicenter, we store the file tree in a [YKeyValueLww](./ykeyvalue-space-efficient-kv-store.md) built on Y.Array instead. The strategy is append-and-cleanup: push the new entry to the end of the array, delete the old entry for the same key. The old value becomes a tiny tombstone. With garbage collection on, those tombstones merge into a few bytes:

| Data structure | 10 keys, 1000 updates each | With gc: true |
|---|---|---|
| Y.Map | 88 KB | Retains all 10,000 historical values |
| YKeyValueLww | 446 bytes | Only 10 current entries survive |

The `Lww` part adds last-write-wins conflict resolution via monotonic timestamps. Two users rename the same file simultaneously: the later timestamp wins. Predictable, deterministic, and exactly right for metadata where nobody expects to "undo" a rename through version history.

The file tree lives on the workspace's main Y.Doc with `gc: true`. This is critical: with garbage collection on, YKeyValueLww's tombstones compact to nothing. A workspace with 500 files updated thousands of times stays under a kilobyte of CRDT overhead. The entire file tree is always in memory because it's tiny, giving us instant file tree rendering, instant search, and instant path resolution.

We keep two in-memory indexes that rebuild on every change:

```typescript
pathToId: Map<string, FileId>             // "/src/index.ts" → FileId
childrenOf: Map<FileId | null, FileId[]>  // parentId → [child IDs]
```

Full rebuild is O(n) where n is total files. For 500 files that's 3-5ms. Incremental updates would be the same complexity, so we don't bother.

Two users creating `api.md` in the same folder concurrently? Both writes succeed with different FileIds. We disambiguate at display time: the earlier `createdAt` keeps the clean name, the later one becomes `api (1).md`. The stored `name` is never mutated for disambiguation. No conflicts, no data loss.

## How Epicenter models file content

This is where revision history matters. Nobody expects to undo a rename by rolling back the file tree. But a user editing a document expects version history: the ability to see what changed, when, and to restore a previous state.

Each file gets its own top-level Y.Doc with `gc: false`:

```typescript
const ydoc = new Y.Doc({ guid: fileId, gc: false });
```

With garbage collection off, tombstones from every deleted character are preserved. This is what enables `Y.snapshot()` to reconstruct any previous state of the document. The storage cost is proportional to edit history, and you only pay it for files the user actually opens.

```
Metadata Y.Doc (gc: true, always loaded)
│
├── Y.Array('table:files')       ← YKeyValueLww, compact
│   └── { key: 'x7kQ2', val: { id: 'x7kQ2', name: 'index.ts', ... }, ts: ... }
│
└── Y.Array('kv:settings')       ← YKeyValueLww, compact
    └── { key: 'theme', val: 'dark', ts: ... }

Content Y.Doc (gc: false, loaded on demand)      ← one per file
├── Y.Text('text')               for code files
├── Y.XmlFragment('richtext')    for .md body
└── Y.Map('frontmatter')         for .md YAML front matter
```

What lives inside each content doc depends on the file type. Code files (`.ts`, `.js`, `.py`, anything that isn't `.md`) get a `Y.Text('text')` that binds directly to CodeMirror via y-codemirror.next. Markdown files get a `Y.XmlFragment('richtext')` that holds a ProseMirror document tree, plus a `Y.Map('frontmatter')` for YAML front matter metadata.

We use type-specific key names rather than a generic `'content'` key because Yjs permanently locks a root-level key to whichever shared type accesses it first. If you call `getText('content')`, that key is bound to Y.Text forever; calling `getXmlFragment('content')` on the same doc throws. Separate keys let both types coexist, which matters when a file gets renamed from `.txt` to `.md`:

```typescript
// Renaming notes.txt → notes.md triggers in-place migration:
// 1. Read content from Y.Text('text')
// 2. Parse front matter delimiters
// 3. Write body to Y.XmlFragment('richtext')
// 4. Write metadata to Y.Map('frontmatter')
// The old Y.Text('text') retains stale content harmlessly
```

The `frontmatter` map uses per-field LWW: each YAML key is a separate Y.Map entry, so two users editing different front matter fields don't conflict. Deep equality checks prevent no-op writes.

Content doc lifecycle is managed by a `ContentDocStore` with three methods: `ensure(fileId)` creates or returns the Y.Doc, `destroy(fileId)` tears it down when a file is permanently deleted, `destroyAll()` shuts down the workspace. The store is a `Map<FileId, Y.Doc>` with zero domain knowledge about file types, editors, or front matter.

## Why this split works

The architecture mirrors how users actually think about their files. The file tree is navigational: you see it, you click around, you rename things, you move folders. It should be instant and cheap. The file content is where real work happens: character-by-character edits, collaborative cursors, undo history, version snapshots. It should preserve everything.

| Layer | GC | CRDT | Loaded | Why |
|---|---|---|---|---|
| File metadata | on | YKeyValueLww | Always | LWW row updates. Tombstones compact to nothing. |
| Settings/KV | on | YKeyValueLww | Always | Infrequent updates. No revision history needed. |
| Code content | off | Y.Text | On demand | Character-level edits need snapshots for version history. |
| Markdown body | off | Y.XmlFragment | On demand | ProseMirror tree edits need snapshots for version history. |
| Front matter | off | Y.Map | On demand | Per-field metadata. Lives on the same doc as the body. |

A workspace with 500 files: the file tree is always in memory at under a kilobyte. Open a file and its content doc loads from IndexedDB or the sync server. Close it and the doc destroys, freeing memory. The user sees 500 files listed instantly but only pays the content cost for the ones they actually open. See [Only the Leaves Need Revision History](./only-the-leaves-need-revision-history.md) for the full rationale behind this split.

---

Related:

- [Only the Leaves Need Revision History](./only-the-leaves-need-revision-history.md): The deeper argument for gc: true on structure, gc: false on content
- [YKeyValue: A Space-Efficient Key-Value Store on Yjs](./ykeyvalue-space-efficient-kv-store.md): How append-and-cleanup on Y.Array achieves 1935x better storage than Y.Map
- [Why Replacing Nested Y.Maps Loses Concurrent Edits](./nested-ymap-replacement-danger.md): Why flat structures beat nested ones in CRDTs
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md): The benchmark that changes everything based on one boolean
