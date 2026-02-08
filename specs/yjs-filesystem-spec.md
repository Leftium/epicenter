# Yjs Filesystem Spec

## Problem

Implement a collaborative file system on top of the static API that supports:
- Hierarchical file/folder organization (Google Drive-like)
- Real-time collaborative editing via Yjs CRDTs
- An `IFileSystem` interface compatible with [just-bash](https://github.com/vercel-labs/just-bash), enabling agents to use grep, find, cat, ls, and 80+ bash commands against the CRDT filesystem

## Constraints

- Static API rows must be JSON-serializable (no nested Y.Text, Y.XmlFragment, Y.Map)
- YKeyValueLww uses last-write-wins at the row level (entire row replaced on write)
- Content must lazy-load (a workspace with 500 files at 10KB each = 5MB; can't load eagerly)
- No subdocument support in providers (y-websocket, y-indexeddb, y-sweet, Hocuspocus)

---

## Architecture: Two Layers + Runtime Indexes

```
Main Y.Doc (gc: true, always loaded)
  └── Y.Array('table:files')  →  file metadata rows (YKeyValueLww)

Per-File Y.Docs (gc: false, loaded on demand)       (fileId IS the Y.Doc GUID)
  Each doc has two root-level keys; only one is "active" based on file extension:
  ├── Y.XmlFragment('richtext')  →  ProseMirror tree  [active for .md files]
  └── Y.Text('text')             →  raw text           [active for all other text files]

Runtime Indexes (ephemeral JS Maps, not in Yjs)
  ├── pathToId:    Map<string, string>      "/docs/api.md" → "abc-123"
  ├── idToPath:    Map<string, string>      "abc-123" → "/docs/api.md"
  ├── childrenOf:  Map<string, string[]>    "parent-id" → ["child-1", "child-2"]
  └── plaintext:   Map<string, string>      "abc-123" → "file content..." (lazy cache)
```

### Why this architecture

**Google Drive uses this exact separation.** A Google Doc has no `size`, no checksum, can't be downloaded — it's a structured data entity in a separate system. The Drive file resource is a metadata pointer connected by file ID. Our `files` table is the Drive file resource. Our content Y.Docs are the Google Docs content system.

**Separate top-level Y.Docs (not subdocs).** Subdocs provide one thing top-level docs don't: parent-doc GUID enumeration. But almost no provider supports subdocs (y-websocket, y-indexeddb, y-sweet, Hocuspocus all don't). The `files` table already enumerates document GUIDs — each file's `id` (a `Guid`) is directly used as the Y.Doc GUID, no composite key needed. AFFiNE uses subdocs and had to build a complete custom provider stack.

**Runtime indexes, not stored paths.** The files table stores `parentId` + `name` as source of truth. Full paths are computed and cached in ephemeral JS Maps. This keeps Yjs writes minimal (move = 1 row update) while giving O(1) path lookups for IFileSystem operations.

---

## Layer 1: File Metadata (Static API Table)

```typescript
import { defineTable, defineWorkspace } from './static';
import { type } from 'arktype';

const files = defineTable(type({
  id: 'string',                       // Guid — globally unique, doubles as Y.Doc GUID for content
  name: 'string',                   // filename: "api.md", "src", "index.ts"
  parentId: 'string | null',        // null = root level
  type: "'file' | 'folder'",        // discriminator
  sortOrder: 'number',              // fractional indexing for sibling order
  size: 'number',                   // content byte length (updated on content change)
  createdAt: 'number',              // Date.now() ms
  updatedAt: 'number',              // Date.now() ms (content or metadata change)
}));

const workspace = defineWorkspace({
  id: 'filesystem',
  tables: { files },
});
```

### Why these fields

| Field | Needed for | Notes |
|-------|-----------|-------|
| `id` | Everything | `Guid` (15-char nanoid). Globally unique. Stable across renames/moves. Doubles as the content Y.Doc GUID — no composite key needed. |
| `name` | `readdir()`, path resolution | Just the filename, not the full path |
| `parentId` | `readdir()`, tree traversal | null = root. ID-based = O(1) move, no cascading updates |
| `type` | `stat()`, `readdirWithFileTypes()` | Derives `isFile()`, `isDirectory()` |
| `sortOrder` | `readdir()` ordering | Fractional indexing for insert-between without renumbering |
| `size` | `stat()`, `ls -l`, `find -size` | Updated by content doc observer. Avoids loading content for stat |
| `createdAt` | `stat()` ctime | Immutable after creation |
| `updatedAt` | `stat()` mtime, `find -newer` | Updated on content OR metadata change |

### What's NOT stored

- **Full path**: Derived at runtime. Storing it means cascade-updating every descendant on rename/move — O(n) Yjs writes vs O(1).
- **Content / plaintext**: Content belongs in content Y.Docs. Mixing it into metadata violates the two-layer separation and bloats the always-loaded main doc.
- **Unix mode/permissions**: Always derived (0o644 for files, 0o755 for folders). Collaborative system — unix permissions don't apply.
- **MIME type**: Derived from file extension at runtime.

---

## Layer 2: File Content (Top-Level Y.Docs)

Each text file gets its own Y.Doc. The file's `id` (a `Guid`) is used directly as the Y.Doc GUID — a clean 1:1 mapping with no composite key.

The Yjs backing type depends on the file extension:

| File type | Yjs type | Editor binding | Serialization |
|-----------|----------|---------------|---------------|
| `.md` | Y.XmlFragment | Milkdown (ProseMirror + remark + y-prosemirror) | remark serialize -> markdown string |
| `.txt`, `.ts`, `.js`, `.rs`, `.py`, `.svelte`, `.json`, `.yaml`, `.toml`, etc. | Y.Text | CodeMirror (y-codemirror.next) | `Y.Text.toString()` (lossless, 1:1) |
| Binary (images, PDFs) | None | N/A | Blob references in files table, not Yjs documents |

### Why file-type-driven backing

No production system maintains both Y.Text and Y.XmlFragment on the same document with bidirectional sync. The markdown-to-structured-document conversion is inherently lossy (whitespace normalization, emphasis style, list markers). Continuous bidirectional sync creates normalization loops.

- **Y.XmlFragment** is required by y-prosemirror (ProseMirror needs a tree, not a flat sequence). Milkdown's `@milkdown/plugin-collab` wraps y-prosemirror internally.
- **Y.Text** maps 1:1 to CodeMirror characters. `Y.Text.toString()` gives exact file content. Zero conversion overhead.

### Content access

```typescript
type TextDocumentHandle = {
  kind: 'text';
  fileId: string;
  ydoc: Y.Doc;
  content: Y.Text;
};

type RichTextDocumentHandle = {
  kind: 'richtext';
  fileId: string;
  ydoc: Y.Doc;
  content: Y.XmlFragment;
};

type DocumentHandle = TextDocumentHandle | RichTextDocumentHandle;

function openDocument(fileId: Guid, fileName: string): DocumentHandle {
  const ydoc = new Y.Doc({ guid: fileId, gc: false }); // fileId IS the GUID; gc: false for snapshots/versioning

  if (fileName.endsWith('.md')) {
    return { kind: 'richtext', fileId, ydoc, content: ydoc.getXmlFragment('richtext') };
  }
  return { kind: 'text', fileId, ydoc, content: ydoc.getText('text') };
}
```

### Content doc GC strategy

- **Main doc** (files table): `gc: true`. LWW doesn't need CRDT history. Efficient.
- **Content docs**: `gc: false`. Enables Yjs snapshots for per-file version history. Matches Google Drive's per-file revision model — no workspace-wide rollback, just individual file history.

---

## Runtime Indexes

The files table is always in memory (it's on the main Y.Doc). Runtime indexes provide O(1) lookups for IFileSystem operations. They're ephemeral JS Maps — not stored in Yjs — rebuilt on load and updated incrementally via `files.observe()`.

```typescript
class FileSystemIndex {
  // Path resolution
  private pathToId = new Map<string, string>();       // "/docs/api.md" → "abc-123"
  private idToPath = new Map<string, string>();        // "abc-123" → "/docs/api.md"

  // Tree traversal
  private childrenOf = new Map<string, string[]>();    // parentId → [childId, ...]

  // Content cache (for grep/search without loading content docs)
  private plaintext = new Map<string, string>();       // fileId → content string

  constructor(private filesTable: TableHelper<FileRow>) {
    this.rebuild();
    this.filesTable.observe((changedIds) => this.update(changedIds));
  }

  private rebuild() {
    // Walk all rows, compute paths, build children index
    const rows = this.filesTable.getAllValid();
    // ... build path tree from parentId chains
  }

  private update(changedIds: Set<string>) {
    // Incrementally update affected paths and children
    // Invalidate plaintext cache for changed files
  }
}
```

### Path resolution: O(depth) build, O(1) lookup

Path computation walks the `parentId` chain: `file → parent → grandparent → ... → null (root)`. This is O(depth) per file, but depth is typically 3-5 levels and the data is in-memory. After initial build, all lookups are O(1) via the Maps.

### Plaintext cache: lazy, reactive

The plaintext cache is populated lazily:
- **Single file read** (`cat`): loads content doc, caches plaintext
- **Recursive search** (`grep -r`): batch-loads uncached content docs, caches all
- **Content changes**: content doc observers update the cache entry

On a server (where agents run), the server has all content docs available and can maintain the full cache eagerly. On clients, the cache populates on demand.

---

## IFileSystem Implementation (just-bash)

[just-bash](https://github.com/vercel-labs/just-bash) is a complete bash interpreter reimplemented in TypeScript. It has 83 built-in commands (grep, find, cat, ls, sed, awk, jq, etc.) that operate against an `IFileSystem` interface. The AI agent integration is a single `bash` tool — the agent writes bash scripts, just-bash interprets them.

By implementing `IFileSystem` backed by the Yjs filesystem, agents get all 83 commands for free with pipe composition, redirections, and shell scripting.

### Interface mapping

```typescript
class YjsFileSystem implements IFileSystem {
  constructor(
    private filesTable: TableHelper<FileRow>,
    private index: FileSystemIndex,
    private openContentDoc: (fileId: string, name: string) => DocumentHandle,
  ) {}

  // --- Reads (metadata only, always fast) ---

  async readdir(path: string): Promise<string[]> {
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);
    const childIds = this.index.childrenOf.get(id) ?? [];
    return childIds.map(cid => this.filesTable.get(cid).row!.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);
    const childIds = this.index.childrenOf.get(id) ?? [];
    return childIds.map(cid => {
      const row = this.filesTable.get(cid).row!;
      return { name: row.name, isFile: () => row.type === 'file', isDirectory: () => row.type === 'folder' };
    });
  }

  async stat(path: string): Promise<FsStat> {
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);
    const row = this.filesTable.get(id).row!;
    return {
      isFile: () => row.type === 'file',
      isDirectory: () => row.type === 'folder',
      isSymbolicLink: () => false,
      size: row.size,
      mtime: new Date(row.updatedAt),
      atime: new Date(row.updatedAt),
      ctime: new Date(row.createdAt),
      mode: row.type === 'folder' ? 0o755 : 0o644,
    };
  }

  async exists(path: string): Promise<boolean> {
    return this.index.pathToId.has(path);
  }

  // --- Reads (content, may load content doc) ---

  async readFile(path: string): Promise<string> {
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);

    // Fast path: plaintext cache
    const cached = this.index.plaintext.get(id);
    if (cached !== undefined) return cached;

    // Slow path: load content doc
    const row = this.filesTable.get(id).row!;
    const handle = this.openContentDoc(id, row.name);
    const text = handle.kind === 'text'
      ? handle.content.toString()
      : serializeXmlFragmentToMarkdown(handle.content); // remark serialize
    this.index.plaintext.set(id, text);
    return text;
  }

  // --- Writes (always through content doc for CRDT semantics) ---

  async writeFile(path: string, content: string): Promise<void> {
    let id = this.index.pathToId.get(path);

    if (!id) {
      // Create file: parse path into parentId + name, insert row
      const { parentId, name } = this.parsePath(path);
      id = generateId();
      this.filesTable.set({
        id, name, parentId, type: 'file', sortOrder: Date.now(),
        size: new TextEncoder().encode(content).length,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }

    // Write content through Yjs
    const row = this.filesTable.get(id).row!;
    const handle = this.openContentDoc(id, row.name);
    if (handle.kind === 'text') {
      handle.ydoc.transact(() => {
        handle.content.delete(0, handle.content.length);
        handle.content.insert(0, content);
      });
    } else {
      // For .md: parse markdown -> ProseMirror node -> apply to XmlFragment
      applyMarkdownToXmlFragment(handle.content, content);
    }

    this.filesTable.update(id, {
      size: new TextEncoder().encode(content).length,
      updatedAt: Date.now(),
    });
    this.index.plaintext.set(id, content);
  }

  // --- Structure (metadata only) ---

  async mkdir(path: string): Promise<void> {
    const { parentId, name } = this.parsePath(path);
    this.filesTable.set({
      id: generateId(), name, parentId, type: 'folder',
      sortOrder: Date.now(), size: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const id = this.index.pathToId.get(oldPath);
    if (!id) throw fsError('ENOENT', oldPath);
    const { parentId: newParentId, name: newName } = this.parsePath(newPath);
    this.filesTable.update(id, { parentId: newParentId, name: newName, updatedAt: Date.now() });
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);
    const row = this.filesTable.get(id).row!;

    if (row.type === 'folder' && options?.recursive) {
      // Recursively delete children
      const childIds = this.index.childrenOf.get(id) ?? [];
      for (const childId of childIds) {
        const childPath = this.index.idToPath.get(childId)!;
        await this.rm(childPath, { recursive: true });
      }
    }

    this.filesTable.delete(id);
    this.index.plaintext.delete(id);
    // Content Y.Doc becomes orphaned. Provider can garbage-collect it.
  }

  // --- Not supported (no-ops or errors) ---

  async symlink(): Promise<void> { throw fsError('ENOSYS', 'symlinks not supported'); }
  async link(): Promise<void> { throw fsError('ENOSYS', 'hard links not supported'); }
  async readlink(): Promise<string> { throw fsError('ENOSYS', 'symlinks not supported'); }

  resolvePath(...paths: string[]): string {
    // Standard POSIX path resolution
    return posixResolve(...paths);
  }
}
```

### Agent integration

```typescript
import { Bash } from 'just-bash';

const yjsFs = new YjsFileSystem(client.tables.files, index, openContentDoc);
const bash = new Bash({ fs: yjsFs, cwd: '/' });

// Single tool exposed to AI agents
const result = await bash.exec('grep -rn "TODO" / --include="*.md" | sort | head -20');
const result2 = await bash.exec('find / -name "*.ts" -newer /CHANGELOG.md');
const result3 = await bash.exec('cat /docs/api.md | wc -l');
const result4 = await bash.exec('ls -la /src/');
```

### Performance characteristics

| Operation | What it touches | Cost |
|-----------|----------------|------|
| `ls /docs/` | Files table (in-memory) + childrenOf index | O(children), fast |
| `find / -name "*.md"` | Files table (in-memory), full scan | O(n) rows, fast |
| `cat /docs/api.md` | Path index + plaintext cache (or content doc load) | O(1) cached, O(load) first time |
| `grep -r "TODO" /` | Path index + plaintext cache for all files | O(n * content) first time, O(n * search) cached |
| `mv /old /new` | 1 row update in files table | O(1) |
| `mkdir /new-dir` | 1 row insert | O(1) |
| `echo "x" > /file.txt` | Content doc load + Yjs transaction + row update | O(1) |

`grep -r` is the expensive case. First invocation loads all content docs into the plaintext cache. Subsequent greps search the cache without any doc loading. just-bash processes files in batches of 50 with `Promise.all()`, so the batch-loading parallelizes well.

---

## Design Decisions

### parentId + name (not full path)

**Decision: Store `parentId` + `name`. Derive full paths at runtime.**

- Full paths require O(n) cascading Yjs writes on rename/move (update every descendant)
- parentId requires O(1) Yjs write on move (update one row)
- CRDTs make this worse: cascading writes create n conflicting LWW entries on concurrent moves
- Google Drive and Dropbox Nucleus both converged on ID-based node identification after learning that path-based identification breaks badly
- Runtime path indexes give O(1) lookups after initial build

### Same table for files and folders

**Decision: Same table with `type: 'file' | 'folder'` discriminator.**

- `readdir()` is one query: `files.filter(f => f.parentId === id)`
- Same tree operations (move, rename, delete) work for both
- Folders simply have no associated content doc

### File-type-driven Yjs backing

**Decision: Y.XmlFragment for `.md`, Y.Text for everything else. Separate root-level keys (`'text'` / `'richtext'`) so both types can coexist on the same doc.**

- y-prosemirror requires Y.XmlFragment (ProseMirror needs a tree structure)
- y-codemirror.next requires Y.Text (1:1 character mapping)
- No production system successfully syncs both representations bidirectionally
- File extension determines the active type — it rarely changes, but when it does (rename), convert-on-switch migrates content between types

### Dual keys with convert-on-switch (content type switching)

**Decision: Each content doc uses two root-level keys — `'text'` (Y.Text) and `'richtext'` (Y.XmlFragment). Only one is "active" at a time, determined by file extension.**

**Why separate keys, not a shared `'content'` key**: Yjs permanently locks a root-level key to whichever shared type is accessed first. If a doc calls `getText('content')`, that key is bound to Y.Text forever — calling `getXmlFragment('content')` on the same doc throws. Separate keys allow both types to coexist, enabling type switching without destroying the document.

**Key names**: `'text'` and `'richtext'` mirror the `kind` discriminator in `DocumentHandle`. They describe what the data represents (content format), not the Yjs type that stores it.

**Convert-on-switch flow:**

Rename `.txt` → `.md`:
1. Read current text: `ydoc.getText('text').toString()`
2. Parse markdown → ProseMirror nodes → apply to `ydoc.getXmlFragment('richtext')`
3. Active content is now `getXmlFragment('richtext')`

Rename `.md` → `.txt`:
1. Serialize: `remarkSerialize(ydoc.getXmlFragment('richtext'))` → markdown string
2. Replace `ydoc.getText('text')` with the serialized string
3. Active content is now `getText('text')`

**Properties:**
- Rename remains a metadata operation (files table) + content migration — same Y.Doc, same GUID, no orphaned docs
- The inactive type sits with stale data (negligible overhead vs content size)
- Round-trip is inherently lossy (markdown ↔ structured tree) — this matches reality of format conversion
- No bidirectional sync — only one type is active at a time, avoiding the normalization loops that plague dual-representation systems

### File IDs are Guids (not table-scoped Ids)

**Decision: File rows use `Guid` (15-char nanoid, globally unique) instead of `Id` (10-char, table-scoped).**

- File IDs double as Y.Doc GUIDs — they must be globally unique across all workspaces, not just unique within the files table
- 1:1 mapping: `fileId` IS the content doc GUID. No composite key (`{workspaceId}:file:{fileId}`), no string construction, no convention to remember
- Cross-workspace file moves don't require re-creating the content doc under a new GUID
- Workspace membership is already tracked by the files table — no need to encode it in the GUID
- Trade-off: 5 extra chars per file ID (15 vs 10). Negligible cost for clean architecture

### Separate top-level Y.Docs (not subdocs, not one big doc)

**Decision: Each file content gets its own independent Y.Doc.**

- One big doc: 500 files * 10KB = 5MB loaded eagerly. Can't lazy-load. No per-file GC control.
- Subdocs: correct semantically but no provider support (y-websocket, y-indexeddb, y-sweet, Hocuspocus all don't support them)
- Top-level docs: lazy-load for free (create Y.Doc on open, destroy on close). Standard provider support. The file's `Guid` is used directly as the Y.Doc GUID — 1:1 mapping, no composite key.

### No filesystem-level rollback

**Decision: Per-file version history only. No workspace-wide snapshots.**

- Google Drive has no version history for metadata (renames, moves are not versioned)
- Rolling back the filesystem means undoing renames that other users already see — semantically wrong
- Per-file snapshots via Yjs (content docs use `gc: false`) match Google's per-file revision model
- Main doc uses `gc: true` for efficient LWW

### Fractional sort ordering

**Decision: Fractional indexing for `sortOrder`.**

- Insert between two siblings without renumbering all siblings
- Standard approach (used by Figma, Linear, Notion)
- Implementation: use a fractional indexing library or generate midpoint strings

---

## Operations

### Create File
1. Generate ID
2. `files.set({ id, name, parentId, type: 'file', sortOrder, size: 0, createdAt: Date.now(), updatedAt: Date.now() })`
3. Content Y.Doc created lazily when first opened

### Create Folder
1. Generate ID
2. `files.set({ id, name, parentId, type: 'folder', sortOrder, size: 0, createdAt: Date.now(), updatedAt: Date.now() })`

### Move File/Folder
1. `files.update(id, { parentId: newParentId, sortOrder: newOrder, updatedAt: Date.now() })`
2. Runtime indexes update reactively via `files.observe()`
3. No cascading updates — children still reference this node by ID

### Rename
1. `files.update(id, { name: newName, updatedAt: Date.now() })`
2. If file extension changed (e.g., `.txt` → `.md` or `.md` → `.txt`):
   a. Load content doc
   b. Serialize from old active type → populate new active type (convert-on-switch)
   c. Invalidate plaintext cache

### Delete
1. `files.delete(id)`
2. Recursively delete children via `childrenOf` index
3. Content Y.Docs become orphaned (provider garbage-collects)
4. Plaintext cache entries evicted

### Read File Content
1. Resolve path to ID via `pathToId` index
2. Check plaintext cache — return if cached
3. Load content Y.Doc, extract text, cache, return

### Write File Content
1. Resolve path to ID (or create file if new)
2. Load content Y.Doc
3. Apply changes via Yjs transaction (Y.Text or Y.XmlFragment)
4. Update `size` and `updatedAt` on files table row
5. Update plaintext cache

### List Children
1. `childrenOf.get(folderId)` for child IDs
2. Map to rows, sort by `sortOrder`

### Resolve Path
1. Look up in `pathToId` index (O(1))
2. On cache miss: walk `parentId` chain from target to root, build path

---

## Validation

### Circular reference detection

Concurrent moves can create cycles (user A moves folder X into folder Y while user B moves folder Y into folder X). Since Yjs resolves each move independently via LWW, both moves can succeed, creating a cycle.

Detection: after any `parentId` change observed via `files.observe()`, walk the `parentId` chain from the moved node. If the chain exceeds a reasonable depth (e.g., 50) or revisits a node, break the cycle by resetting the later-timestamped move's `parentId` to null (move to root).

### Orphan detection

If a file's `parentId` references a deleted folder, the file is orphaned. On index rebuild, detect orphans and either:
- Surface them at root level (safe default)
- Move to a "lost+found" virtual folder

---

## Testing Strategy

just-bash has comprehensive test suites for filesystem operations that serve as validation targets:

- **`find.basic.test.ts`**: Finding files/dirs by name, type, depth. Tests `readdir()`, `stat()`, `readdirWithFileTypes()`.
- **`find.patterns.test.ts`**: Glob patterns, regex, case-insensitive matching. Tests path resolution.
- **`find.printf.test.ts`**: Printf formatting with file metadata. Tests `stat()` field accuracy (size, mtime, mode).
- **`ls.test.ts`**: Listing, hidden files, long format, recursive. Tests `readdir()`, `stat()`, `readdirWithFileTypes()`.
- **`grep` tests**: Recursive search, include/exclude patterns. Tests `readFile()` + `readdir()` traversal.
- **`cat` tests**: File reading, stdin, line numbers. Tests `readFile()`.

The testing approach: populate a `YjsFileSystem` with known files/folders, pass it to `new Bash({ fs: yjsFs })`, and run the same test scripts that just-bash uses against its `InMemoryFs`. The IFileSystem contract is the compatibility target.

---

## Open Questions

1. **Markdown source view**: Convert-on-switch is the strategy for file type changes (rename). Remaining question: should the editor offer a source-view toggle within a `.md` file (show raw markdown in CodeMirror alongside or instead of the rich editor)?
2. **Binary files**: Store blob references in files table metadata? Separate blob storage system?
3. **File size limits**: Large files (>1MB) as Y.Text are expensive. Read-only mode above a threshold?
4. **Trash/recycle bin**: Soft-delete with a `trashedAt` field, or hard delete?
5. **Plaintext cache warming**: Should the server eagerly cache all content for fast first-grep? Or always lazy?
