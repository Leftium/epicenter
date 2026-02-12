# Research: Per-File Y.Doc Architecture for Multi-Mode Content Storage

**Status**: Research / Discussion Document
**Date**: 2026-02-11
**Related**: `specs/20260211T200000-yjs-filesystem-conformance-fixes.md`, `specs/20260208T000000-yjs-filesystem-spec.md`

> This document presents architectural options for supporting text, markdown, and binary content in per-file Yjs documents. No option is recommended — this is a discussion document for further deliberation.

---

## Problem Statement

Epicenter's Yjs filesystem currently stores text in `Y.Text('content')` per file, but binary files go to an ephemeral `Map<FileId, Uint8Array>` that **doesn't sync or persist**. This is asymmetrical — text gets full CRDT collaboration, binary gets nothing.

**Goal**: Support three content modes in a single per-file Y.Doc (`gc:false` for revision history):
1. **Text**: Character-level CRDT via `Y.Text` (for `.ts`, `.js`, `.txt`)
2. **Markdown**: `Y.XmlFragment` + `Y.Map` frontmatter (for `.md`) — helpers exist, not wired in
3. **Binary**: `Uint8Array` via `ContentBinary` (for `.png`, `.sqlite`, compiled output)

**Requirements**:
- Binary data syncs and persists (not ephemeral)
- Reconstruct which content mode was active at any `Y.snapshot()` point
- Files can switch modes during a bash session (`echo "text" > f.dat` then `gzip f.dat`)
- Minimize tombstone/storage bloat with `gc:false`

---

## Key Research Findings

### Yjs Binary Support
- `Y.Map.set(key, Uint8Array)` works natively — stored as `ContentBinary` (atomic, no split/merge)
- `Y.Array.push([Uint8Array])` also works — `Uint8Array` is a supported `Y.Array` value type
- With **gc:false**: each `Y.Map` key overwrite retains the FULL previous `Uint8Array` as a tombstone. Write 1MB 10 times = 10MB of dead data.
- `Y.Array` append-only entries have ~40-50 bytes overhead each. Old entries persist by design.

### Snapshots
- `Y.snapshot(ydoc)` captures ALL shared types (`Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment`) simultaneously
- `Y.createDocFromSnapshot(originDoc, snapshot)` restores exact state of all shared types at snapshot time
- Requires `gc:false` on the origin doc
- You CAN inspect `Y.Map` values, `Y.Text` content, and `Y.Array` entries from a reconstructed snapshot

### Current Implementation
```
Per-file Y.Doc (gc: false, guid = FileId)
└── Y.Text('content')     ← ALL text files use this single key
    (binary → ephemeral Map, not in Y.Doc)
```
- `ContentDocStore`: ~30 lines, creates Y.Doc with `gc:false`, ensure/destroy/destroyAll
- Markdown helpers (`parseFrontmatter`, `serializeXmlFragment`, etc.) exist but NOT wired into filesystem
- No content-type metadata stored in the Y.Doc itself
- Binary data is lost on restart (session-only)

### JustBash Model (for context)
- Stores everything as `Uint8Array` internally. Text = `TextEncoder.encode(string)`
- `InMemoryFs` is essentially `Map<string, Uint8Array>` with path normalization
- `IFileSystem` interface is type-agnostic — `writeFile` accepts both string and `Uint8Array`

### HeadDoc Pattern (for inspiration)
The HeadDoc uses per-client MAX aggregation for safe concurrent epoch bumps:
```
Y.Map('epochs')
  └── "client-123": 3   // Client A's proposal
  └── "client-456": 5   // Client B's proposal

getEpoch() → MAX(3, 5) = 5
```
Each client writes to their own key, eliminating LWW conflicts. The global value is derived by aggregation.

### Yjs Nested Shared Types
- `Y.Map.set(key, new Y.Text())` works — the `Y.Text` becomes a fully functional nested shared type once the parent is integrated into the doc
- `Y.Array.push([ymap])` with a `Y.Map` containing nested `Y.Text`/`Y.XmlFragment` — all nested types are live and editable after push
- Editor bindings (`y-codemirror`, `y-prosemirror`) accept shared type **instances**, not key names — so they bind to nested types just fine
- **Constraint**: A shared type instance can only exist in one location. Cannot reuse the same `Y.Text` in two array entries.
- **Constraint**: Shared types cannot be moved once added to a document (Yjs fundamental rule — see LearnYJS findings below)

### LearnYJS Findings (Gotchas That Apply)

From [learn.yjs.dev](https://learn.yjs.dev):

**Lesson 1 — Use the right shared type for the data:**
- Primitives in `Y.Map` → LWW (last writer wins, concurrent writes lose data)
- `Y.Text` → character-level merge (both concurrent edits survive)
- Rule: Never store collaborative text as a string in `Y.Map`. Use `Y.Text`.

**Lesson 2 — Don't have two clients write to the same key for additive values:**
- `read → modify → write` on a shared `Y.Map` key is broken under latency (classic lost-update problem)
- Solution: per-client key partitioning (G-Counter pattern). Each client writes to its own key, aggregate by iterating all values.
- Applies to our design: the `ts` field in timeline entries is set once by one client at push time — no read-modify-write race.

**Lesson 3 — Shared types can NEVER be moved:**
- "Move" in `Y.Array` = delete + insert. Yjs sees these as unrelated operations.
- Concurrent move causes **data loss** (delete destroys updated state) and **duplication** (both clients insert a "copy")
- Solution: don't move. Use property mutation (fractional indexing) instead of positional changes.
- Applies to our design: append-only timeline never moves entries. This is a feature, not a limitation.

**Lesson 2+3 combined — Y.Array concurrent push ordering:**
- When two clients push to the end of a `Y.Array` simultaneously, both entries appear
- Ordering is deterministic (by `clientID` — lower goes left, higher goes right)
- But **clientID is random**, so ordering is arbitrary from the application's perspective
- **"Last entry" ≠ "latest operation"** — array position reflects clientID ordering, not wall-clock time
- Implication: must use application-level timestamps (`ts` field) to determine "current", not array index position

### Y.Array Concurrent Push: The "Last Entry" Problem

This is the critical gotcha for any append-only log design:

```
Client A (clientID = 5, ts = 100): pushes {type:'binary'}
Client B (clientID = 12, ts = 95):  pushes {type:'text'}

After sync, Y.Array order: [entryA, entryB]
  entryB is "last" because clientID 12 > 5
  But entryA has the HIGHER timestamp (100 > 95)

array.get(array.length - 1) → entryB (WRONG — older operation)
MAX(ts) scan               → entryA (CORRECT — latest operation)
```

**When does this happen?** Only when two clients push within the same sync cycle (milliseconds on LAN, seconds on bad connection). For file mode switches (triggered by explicit user actions or bash commands), concurrent pushes are astronomically rare. But the `ts` field costs one number per entry — cheap insurance.

**Resolution**: Always determine "current" by scanning tail entries for MAX `ts`, never by array index. In practice, only the last 2-3 entries need checking (concurrent pushes cluster at the tail).

---

## Architectural Options

### Option A: Reserved Keys + Active Type Marker

```
Y.Doc (guid = fileId, gc: false)
├── Y.Map('meta')           → { activeType: 'text' | 'markdown' | 'binary' }
├── Y.Text('content')       → text (active when type='text')
├── Y.XmlFragment('richtext') → ProseMirror tree (active when type='markdown')
├── Y.Map('frontmatter')    → YAML fields (active when type='markdown')
└── Y.Map('binary')         → { content: Uint8Array } (active when type='binary')
```

**How it works**: Read `meta.activeType`, dispatch to the correct shared type.

| Aspect | Detail |
|--------|--------|
| Text write | Set `activeType='text'`, clear-and-rebuild `Y.Text` |
| Binary write | Set `activeType='binary'`, `Y.Map('binary').set('content', data)` |
| Type switch | Single transaction: update meta + write to new type's shared type |
| Snapshot reconstruction | Read `meta.activeType` from snapshot, then read the correct shared type |
| Concurrent type switch | LWW on `meta.activeType` — one wins, other's content is stale but preserved |
| Transition history | **None** — only current type tracked. Snapshots implicitly capture type at each point. |

**Pros**: Simplest implementation. One key read to determine type. Matches the superseded content-format-spec pattern (`specs/20260210T120000-content-format-spec.md`).

**Cons**: No explicit transition history. Binary tombstone accumulation (each overwrite retains full `Uint8Array`). Concurrent type switches resolved by arbitrary LWW.

---

### Option B: Y.Array Transition Log (Binary Inline)

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')           → text (active when last transition type='text')
├── Y.XmlFragment('richtext')   → ProseMirror tree (type='markdown')
├── Y.Map('frontmatter')        → YAML fields (type='markdown')
└── Y.Array('transitions')      → append-only log:
     [
       { type: 'text', ts: 1707000000 },
       { type: 'binary', ts: 1707001000, data: Uint8Array([...]) },
       { type: 'text', ts: 1707002000 },
     ]
```

**How it works**: Active type = last entry in transitions array. Binary data stored INLINE in the array entry (since it's atomic anyway). Text/markdown content stays in top-level shared types.

| Aspect | Detail |
|--------|--------|
| Text write | If switching from binary: append `{type:'text', ts}`. Then write `Y.Text`. |
| Binary write | Always append `{type:'binary', ts, data: Uint8Array}` |
| Type switch | Append new entry to transitions array |
| Snapshot reconstruction | Read transitions array from snapshot, last entry = active type |
| Concurrent type switch | Two entries appended. Resolve by MAX timestamp (HeadDoc pattern). |
| Transition history | **Full audit trail** — every type change AND every binary write is an entry |

**What happens when binary is overwritten while staying binary?**
- Each binary write appends a NEW array entry with the full `Uint8Array`
- Previous entries persist (`gc:false`) — this IS the revision history
- 10 writes of 1MB = 10 entries = 10MB. Same total storage as Option A, but semantically "history" not "tombstones"

**Pros**: Natural audit trail. Append-only aligns with `gc:false` philosophy. HeadDoc MAX-ts pattern handles concurrent switches.

**Cons**: "Last entry" ambiguity with concurrent appends (needs MAX-ts resolution). Binary data in `Y.Array` might have serialization nuances. More complex `readFile` (scan to last entry).

---

### Option B2: Y.Array Transitions (Metadata Only) + Separate Binary Storage

Same as B, but binary data in `Y.Map('binary')` with key `'content'`. Array entries for binary omit `data` field.

**Difference from B**: Binary overwrites while staying binary update `Y.Map` (tombstoning previous value) instead of appending new array entries. Array only grows on MODE SWITCHES.

**Tradeoff**: Fewer array entries, but reintroduces `Y.Map` binary tombstone problem from Option A.

---

### Option C: Everything in Y.Array (Unified Content Log) — ELIMINATED

```
Y.Doc (guid = fileId, gc: false)
└── Y.Array('content')
     [
       { v: 1, type: 'text', data: 'console.log("hi")' },
       { v: 2, type: 'binary', data: Uint8Array([...]) },
       { v: 3, type: 'text', data: 'console.log("updated")' },
     ]
```

**ELIMINATED.** Gives up character-level CRDT entirely. Cannot bind CodeMirror/ProseMirror. Every text edit stores the full file content as a new entry. Defeats the core value proposition of Yjs.

---

### Option D: Y.Array Transitions (Mode Switches Only) + Dedicated Storage

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')          → text
├── Y.XmlFragment('richtext')  → markdown body
├── Y.Map('frontmatter')       → markdown metadata
├── Y.Map('binary')            → { content: Uint8Array }
└── Y.Array('transitions')     → metadata only: [{ type, ts, size }]
```

Transition entries only appended on MODE SWITCH. Within a mode, edits go directly to the dedicated shared type.

| Aspect | Detail |
|--------|--------|
| Text write (staying in text) | Just edit `Y.Text`. No transition entry. |
| Binary write (staying in binary) | `Y.Map('binary').set('content', data)`. No transition entry. |
| Mode switch | Append `{type, ts, size}` to transitions array |
| Snapshot reconstruction | Read transitions array, last entry = active type, read from correct shared type |
| Concurrent type switch | MAX-ts on transitions array |

**Pros**: Lightweight transition log (only mode switches, not every write). Character-level CRDT for text. Binary persists via `Y.Map`.

**Cons**: Binary tombstone accumulation in `Y.Map` (same as Option A). Two sources of truth for binary history (tombstones in `Y.Map` + transitions in array).

---

### Option E: HeadDoc-Inspired Per-Client Type Proposals

```
Y.Doc (guid = fileId, gc: false)
├── Y.Text('content')
├── Y.XmlFragment('richtext')
├── Y.Map('frontmatter')
├── Y.Map('binary')            → { content: Uint8Array }
└── Y.Map('activeType')        → per-client proposals:
     {
       'client-123': { type: 'text', ts: 1707000000 },
       'client-456': { type: 'binary', ts: 1707001000 },
     }
```

Active type = proposal with highest `ts` (MAX aggregation, same as HeadDoc epochs).

| Aspect | Detail |
|--------|--------|
| Type switch | `activeType.set(clientId, { type, ts: Date.now() })` |
| Active type resolution | Iterate all entries, pick highest `ts` |
| Concurrent safety | Each client writes to own key — no LWW conflicts |

**Pros**: Concurrent type switches are conflict-free. Proven pattern from HeadDoc.

**Cons**: No transition history. Accumulates one entry per client that ever touched the file. Overkill if concurrent type switches are rare.

---

### Option F: Single Y.Array Timeline with Nested Shared Types

This option eliminates top-level key pollution entirely. A single `Y.Array` IS the entire content history. Each entry is a `Y.Map` containing the content mode discriminant, a timestamp, and a **nested shared type** appropriate for that mode. The nested `Y.Text` or `Y.XmlFragment` is a fully functional CRDT — bindable to editors, supporting character-level concurrent editing.

```
Y.Doc (guid = fileId, gc: false)
│
└── Y.Array('timeline')
    │
    ├── [0] Y.Map                              ← v0: plain text
    │   ├── 'type' → 'text'
    │   ├── 'ts'   → 1707000000
    │   └── 'content' → Y.Text("hello world")  ← nested CRDT, bind to CodeMirror
    │
    ├── [1] Y.Map                              ← v1: markdown
    │   ├── 'type'        → 'richtext'
    │   ├── 'ts'          → 1707001000
    │   ├── 'body'        → Y.XmlFragment(...)  ← nested CRDT, bind to ProseMirror
    │   └── 'frontmatter' → Y.Map({ title: 'My Post', tags: [...] })
    │
    ├── [2] Y.Map                              ← v2: binary
    │   ├── 'type' → 'binary'
    │   ├── 'ts'   → 1707002000
    │   └── 'data' → Uint8Array([0x89, 0x50, ...])  ← atomic
    │
    └── [3] Y.Map                              ← v3: back to text (CURRENT)
        ├── 'type' → 'text'
        ├── 'ts'   → 1707003000
        └── 'content' → Y.Text("updated")      ← BRAND NEW Y.Text, isolated history
```

**Entry structure (discriminated union):**

All entries share common keys:
- `'type'`: `'text' | 'richtext' | 'binary'` — the discriminant
- `'ts'`: `number` (`Date.now()` at creation) — for MAX-ts current-version resolution

Type-specific keys:

| Key | `text` | `richtext` | `binary` | Value Type |
|-----|--------|------------|----------|------------|
| `'content'` | Y.Text | — | — | nested shared type |
| `'body'` | — | Y.XmlFragment | — | nested shared type |
| `'frontmatter'` | — | Y.Map | — | nested shared type |
| `'data'` | — | — | Uint8Array | atomic bytes |

**How reading works:**

```ts
function getCurrentEntry(timeline: Y.Array<Y.Map<any>>): Y.Map<any> {
  if (timeline.length === 1) return timeline.get(0)
  // Scan from end — concurrent pushes cluster at tail
  let best = timeline.get(timeline.length - 1)
  for (let i = timeline.length - 2; i >= 0; i--) {
    const entry = timeline.get(i)
    if (entry.get('ts') > best.get('ts')) best = entry
    else break // past the concurrent zone
  }
  return best
}

function readFile(timeline): string | Uint8Array {
  const entry = getCurrentEntry(timeline)
  switch (entry.get('type')) {
    case 'text':     return entry.get('content').toString()
    case 'richtext': return serializeMarkdown(entry.get('body'), entry.get('frontmatter'))
    case 'binary':   return entry.get('data')
  }
}
```

**How writing works:**

```
SAME-MODE EDIT (common — no new array entry):
  Current entry [3]: { type:'text', content: Y.Text }
  User types "foo"
  → entry.get('content').insert(pos, 'foo')
  → Standard CRDT ops on nested Y.Text. Array unchanged.

MODE SWITCH (rare — appends new entry):
  doc.transact(() => {
    const entry = new Y.Map()
    entry.set('type', 'binary')
    entry.set('ts', Date.now())
    entry.set('data', compressedBytes)
    timeline.push([entry])
  })
```

| Aspect | Detail |
|--------|--------|
| Text write (same mode) | Edit nested `Y.Text` directly. No array entry. Full CRDT. |
| Binary write (same mode) | **Append new entry** (binary is atomic — each write is a new version) |
| Mode switch | Append new `Y.Map` entry with fresh nested shared types |
| Current version | `MAX(ts)` scan of tail entries |
| Concurrent same-mode edit | Standard Yjs CRDT merge on the nested shared type |
| Concurrent mode switch | Both entries appear in array. `MAX(ts)` picks the winner deterministically. |
| Snapshot reconstruction | `Y.createDocFromSnapshot()` restores entire array. Scan for `MAX(ts)` at that point. |

**Why this avoids tombstones on mode switch (key advantage over Options A–E):**

In Options A/D/E, switching text → binary → text requires **clearing** the single `Y.Text` (creating deletion tombstones for entire content), then rewriting:
```
Option A text→binary→text:
  Y.Text: "hello world"
  Y.Text: delete(0, 11)     ← tombstones for ENTIRE content
  Y.Text: insert(0, "new")  ← new content
  Dead weight: full original content as deletion tombstones
```

In Option F, the old `Y.Text` stays intact. A new version gets a fresh `Y.Text`:
```
Option F text→binary→text:
  [0] Y.Text: "hello world"   ← untouched, no tombstones created
  [1] binary: Uint8Array(...)
  [2] Y.Text: "new"           ← brand new, clean
  Dead weight: none (old content is "history", not tombstones)
```

With `gc:false`, you're keeping everything anyway. But there's a meaningful semantic difference between "preserved version history" (each entry is a self-contained version you could inspect or restore) and "useless deletion tombstones from clear-and-rewrite" (artifact of the single-shared-type approach).

**The timeline IS the file history.** Every mode the file has ever been in, when it switched, and what its content was at each stage — all captured in a single, ordered, append-only data structure. This is something `Y.snapshot()` alone doesn't give you as cleanly: snapshots show state at a point in time, but you'd need to scan many snapshots to reconstruct the transition timeline. The array makes it explicit and queryable.

**Downsides:**

1. **Slightly more complex access pattern.** `doc.getArray('timeline').get(n).get('content')` instead of `doc.getText('content')`. More indirection, but encapsulated in a helper.

2. **Must use MAX-ts, not array index, for current version.** Array position is determined by `clientID` on concurrent pushes, not by wall-clock time. In practice only the last 2-3 entries need checking, and concurrent mode switches are astronomically rare.

3. **Editing wrong version after concurrent push.** If Client A is editing entry [2]'s `Y.Text` when Client B pushes entry [3], A's edits land in the stale version. Not lost — preserved in [2]'s history — but orphaned from "current." UI must observe the array and rebind. Window for this is network latency.

4. **Shared type overhead.** Each mode switch creates a new `Y.Text` or `Y.XmlFragment` (~100-200 bytes base overhead). A file that switches modes 50 times has 50 shared type instances = ~10KB. Negligible compared to actual content.

5. **Binary overwrites within binary mode.** Each binary write appends a new entry (unlike text, where edits are CRDT ops on the nested `Y.Text`). 10 writes of 1MB = 10 entries = 10MB. Same cost as Y.Map tombstones in other options, but semantically "version history" rather than "dead data."

---

## Storage Cost Comparison (gc:false)

Scenario: File starts as text (10KB), edited 50 times, converted to binary (1MB), updated 5 times, back to text.

| Component | Option A | Option B | Option D | Option E | **Option F** |
|-----------|----------|----------|----------|----------|----------|
| Text edits (50 char-level) | ~25KB | ~25KB | ~25KB | ~25KB | ~25KB |
| Binary overwrites (5 x 1MB) | 5MB (Y.Map tombstones) | 5MB (5 array entries) | 5MB (Y.Map tombstones) | 5MB (Y.Map tombstones) | 5MB (5 array entries) |
| Type transitions metadata | ~240B | ~150B | ~150B | ~200B | ~200B |
| Mode-switch tombstones | ~20KB (clear Y.Text + rewrite) | ~20KB | ~20KB | ~20KB | **0** (no clear needed) |
| Shared type overhead | 1 per type (fixed) | 1 per type (fixed) | 1 per type (fixed) | 1 per type (fixed) | 1 per version (~400B for 2 switches) |
| **Total** | **~5.05MB** | **~5.05MB** | **~5.05MB** | **~5.05MB** | **~5.03MB** |

**The binary data cost is inherent with gc:false regardless of structure.** The difference between options is:
- **Semantic**: tombstones (dead data from overwrites) vs. history entries (queryable version records)
- **Mode-switch tombstones**: Options A–E clear-and-rewrite shared types on mode switch, creating deletion tombstones. Option F creates fresh shared types — no deletion tombstones at all. The savings are small (~20KB in this scenario) but the semantic difference is significant: Option F's old versions are intact and inspectable, not tombstoned debris.

### What "No Tombstones on Mode Switch" Actually Means

With `gc:false`, all data is retained regardless. But there's a meaningful difference:

**Options A–E (clear-and-rewrite):**
```
text→binary→text lifecycle of Y.Text('content'):
  1. Y.Text created, 50 edits accumulated (25KB of ops)
  2. Mode switch to binary: Y.Text.delete(0, length) → deletion tombstones
  3. Mode switch back to text: Y.Text.insert(0, newContent) → new ops
  Result: Y.Text contains 25KB of original ops + deletion tombstones + new ops
          The original text is unrecoverable as structured data (it's in tombstones)
```

**Option F (fresh types per version):**
```
text→binary→text lifecycle:
  [0] Y.Text: 50 edits accumulated (25KB of ops) — INTACT, inspectable
  [1] binary entry: Uint8Array
  [2] Y.Text: new content, fresh ops — CLEAN
  Result: Each version is a self-contained record. v0's edit history is fully preserved.
          You could bind an editor to v0 and see the original text.
```

---

## Decision Axes

Storage costs are equivalent across all viable options. The real decision axes are:

| Question | Options That Solve It |
|----------|----------------------|
| Explicit, queryable transition history? | B, D, **F** (Y.Array log) |
| Conflict-safe concurrent type switching? | E (per-client proposals), B/**F** (MAX-ts on array) |
| Maximum simplicity? | A (single meta key) |
| No tombstones on mode switch? | **F only** (fresh nested types per version) |
| Minimal top-level key pollution? | **F** (single key: `'timeline'`) |
| Self-contained version records? | **F** (each array entry is a complete version with its own CRDT) |
| Timeline as file history? | **F** (the array IS the history — each entry is inspectable) |

### Why the timeline-as-history property matters

Options A–E separate "where the content lives" (top-level shared types) from "what mode is active" (marker or log). This creates a split-brain problem:
- The content is in `Y.Text('content')` or `Y.Map('binary')`, shared across all versions
- The transitions log says which mode is active, but the content for past modes has been overwritten or tombstoned
- To see what a file looked like at version N, you need `Y.createDocFromSnapshot()` — there's no way to directly inspect past versions

Option F unifies content and metadata in each array entry. Each entry is a **self-contained version record**:
- Entry [0] has its own `Y.Text` with the complete edit history of that text era
- Entry [1] has its own binary data
- Entry [2] has its own `Y.Text` with a fresh edit history
- You can inspect any version without snapshots — just read the entry

This makes the Y.Array a natural **version timeline**. For a filesystem that tracks revision history (`gc:false`), this is a compelling structural alignment: the data structure mirrors the conceptual model.

### Counterargument: Is this over-engineering?

Options A and D are simpler. If you never need to inspect past versions except through `Y.snapshot()`, the timeline approach adds complexity for a feature you don't use. The honest question is: **will you actually read past entries, or is `Y.snapshot()` sufficient?**

If the answer is "snapshots are enough," Option A is the pragmatic choice. If the answer is "I want the file's mode history to be directly queryable and each version to be independently inspectable," Option F is the natural fit.

### The "redundant with snapshots" argument, revisited

Snapshots capture the entire doc state at a point in time. But:
- You need to know **when** to take snapshots (before every mode switch? on every write?)
- Snapshots are external to the doc — they're separate binary blobs you must store and index
- Reconstructing a snapshot requires the original doc with `gc:false`
- There's no way to list "all the modes this file has been in" from snapshots alone

The Y.Array timeline makes this implicit. The history is in the doc itself, not in external snapshot blobs. The array's length tells you how many versions exist. Each entry's `type` and `ts` fields give you the full transition timeline without any external bookkeeping.

---

## Open Questions for Further Discussion

### Resolved or narrowed by Option F analysis

1. ~~**Binary overwrite strategy**~~: In Option F, each binary overwrite appends a new array entry (explicit version). Same storage cost as Y.Map tombstones, but semantically "version history" rather than "dead data." **Resolved: append-only entries.**

2. ~~**Should stale keys be cleared on type switch?**~~ Option F doesn't have stale keys. Each version is self-contained. Old entries just sit in the array as history. **Resolved: not applicable.**

3. ~~**Is Y.Array the right CRDT type for the log?**~~ Yes. The "last entry" ambiguity from concurrent pushes is resolved by MAX-ts scanning of tail entries. In practice, concurrent mode switches on the same file are astronomically rare. **Resolved: Y.Array with MAX-ts.**

4. ~~**Can options be combined?**~~ Option F subsumes the useful properties of B (explicit history), D (lightweight log), and E (MAX-ts resolution) into a single structure. **Resolved: Option F is the combined approach.**

### Still open

5. **Markdown vs text: extension-based or explicit type marker?** Extension-based: rename `.txt` → `.md` triggers type change. Marker-based: type stored in the entry's `type` field, independent of filename. The `type` field in Option F entries is explicit — but what triggers setting it? Could be: (a) always infer from file extension at write time, (b) user/editor explicitly sets the mode, (c) content detection heuristic.

6. **`readFileBuffer(path)` return type**: Needs to return `Uint8Array`. For binary: zero-copy from entry's `data`. For text: `TextEncoder.encode(ytext.toString())`. For richtext: serialize markdown then encode. This is straightforward but the serialization path for richtext needs the existing markdown helpers wired in.

7. **Binary overwrite: new entry or mutate existing?** When a file stays in binary mode and gets overwritten, should we: (a) append a new array entry (full version history, array grows), or (b) update the existing entry's `data` field (in-place overwrite, previous value becomes a Y.Map tombstone within the entry)? Option (a) gives explicit binary version history. Option (b) keeps the array shorter but loses the "each entry is a version" property for binary-only overwrites. Leaning toward (a) for consistency.

8. **Should the `ts` field use wall-clock time or a logical clock?** `Date.now()` is simple but can be wrong (clock skew, NTP jumps). A Lamport timestamp or hybrid logical clock (HLC) would be more correct but adds complexity. For the MAX-ts resolution of concurrent pushes, clock skew of a few seconds is tolerable — the operation that "wins" being off by a few seconds doesn't matter in practice.

9. **How does the UI observe mode changes?** When a new entry is pushed to the timeline (mode switch), the editor needs to: detect the change (observe the array), determine the new current entry (MAX-ts), unbind from the old shared type, and bind to the new one. What's the observation pattern? `timeline.observe(event => { ... })` watching for insert events at the tail.

10. **What about very large binary files?** A 100MB binary file overwritten 10 times = 1GB in the Y.Doc. With `gc:false`, this is unavoidable in any option. Should there be a size threshold where binary content is stored outside the Y.Doc (e.g., in a separate blob store with only a hash/reference in the entry)?

---

## Related Documents

- `specs/20260208T000000-yjs-filesystem-spec.md` — Current filesystem spec
- `specs/20260211T200000-yjs-filesystem-conformance-fixes.md` — Recent conformance fixes
- `specs/20260210T120000-content-format-spec.md` — Superseded content format spec (Option A pattern)
- `docs/articles/archived-head-registry-patterns.md` — HeadDoc per-client MAX pattern
- `docs/articles/y-array-tombstones-are-tiny.md` — Y.Array tombstone analysis
- `docs/articles/ykeyvalue-gc-the-hidden-variable.md` — gc:false storage implications

## Files to Modify (When Implementing)

- `packages/epicenter/src/filesystem/yjs-file-system.ts` — Core: add type dispatch to readFile/writeFile
- `packages/epicenter/src/filesystem/types.ts` — Add ContentType union, update interfaces
- `packages/epicenter/src/filesystem/markdown-helpers.ts` — Wire into writeFile/readFile for markdown mode
- `packages/epicenter/src/filesystem/content-doc-store.ts` — May need type-aware helpers
- `packages/epicenter/src/filesystem/yjs-file-system.test.ts` — Tests for binary persistence, type switching, concurrent edits
