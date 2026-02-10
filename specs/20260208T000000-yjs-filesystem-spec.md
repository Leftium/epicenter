# Yjs Filesystem Spec

**Date**: 2026-02-08T00:00:00
**Status**: Planning

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
  Each doc has three root-level keys; active keys depend on file extension:
  ├── Y.XmlFragment('richtext')  →  ProseMirror tree (body only, no front matter)  [active for .md]
  ├── Y.Text('text')             →  raw text           [active for code/txt files]
  └── Y.Map('frontmatter')       →  { title: "Hello", date: "2026-02-09", ... }   [active for .md]

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
  size: 'number',                   // content byte length (updated on content change)
  createdAt: 'number',              // Date.now() ms
  updatedAt: 'number',              // Date.now() ms (content or metadata change)
  trashedAt: 'number | null',       // null = active, timestamp = soft-deleted
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
| `name` | `readdir()`, path resolution | Just the filename, not the full path. Must not contain `/`, `\`, or null bytes — see [Name validation](#name-validation). Unique per `(parentId, name)` among active files — enforced with `EEXIST` on write, disambiguated at read layer for CRDT conflicts. See [Name uniqueness](#name-uniqueness-eexist-on-write--display-disambiguation-for-crdt-conflicts). |
| `parentId` | `readdir()`, tree traversal | null = root. ID-based = O(1) move, no cascading updates |
| `type` | `stat()`, `readdirWithFileTypes()` | Derives `isFile`, `isDirectory` |
| `size` | `stat()`, `ls -l`, `find -size` | Updated by content doc observer. Avoids loading content for stat |
| `createdAt` | UI display | Immutable after creation. Used by UI ("created 3 days ago"). Not surfaced in `FsStat` (just-bash has no `birthtime`). |
| `updatedAt` | `stat()` mtime, `find -newer` | Updated on content OR metadata change. |
| `trashedAt` | Soft delete / trash | `null` = active file. Timestamp = when trashed. `readdir()` filters out trashed files. IFileSystem `rm` sets this (soft delete). Permanent delete = `files.delete(id)` via "empty trash" UI only. |

### What's NOT stored

- **Full path**: Derived at runtime. Storing it means cascade-updating every descendant on rename/move — O(n) Yjs writes vs O(1).
- **Content / plaintext**: Content belongs in content Y.Docs. Mixing it into metadata violates the two-layer separation and bloats the always-loaded main doc.
- **Unix mode/permissions**: Always derived (0o644 for files, 0o755 for folders). `chmod()` is a no-op (silently succeeds to satisfy just-bash). Collaborative system — unix permissions don't apply.
- **MIME type**: Derived from file extension at runtime.
- **File extension**: Stored as part of `name` (single field). Extensions are a convention, not a structural element — files without extensions (`Makefile`, `.gitignore`) and files with multiple dots (`file.test.ts`, `archive.tar.gz`) make splitting ambiguous. Every real filesystem and API (ext4, APFS, Google Drive, Dropbox) stores a single name.
- **Sort order**: No filesystem or file API (Google Drive included) supports user-defined sibling ordering. `ls` and `readdir` sort at the application layer. If a UI file tree with drag-and-drop reordering is needed later, add a nullable `sortOrder` field — it's a non-breaking additive change.

---

## Layer 2: File Content (Top-Level Y.Docs)

Each text file gets its own Y.Doc. The file's `id` (a `Guid`) is used directly as the Y.Doc GUID — a clean 1:1 mapping with no composite key.

The Yjs backing type depends on the file extension:

| File type | Yjs type | Editor binding | Serialization |
|-----------|----------|---------------|---------------|
| `.md` | Y.XmlFragment('richtext') + Y.Map('frontmatter') | Milkdown (ProseMirror + y-prosemirror) for body; Y.Map for metadata | Y.Map → YAML + remark serialize → markdown body, combined with `---` delimiters |
| `.txt`, `.ts`, `.js`, `.rs`, `.py`, `.svelte`, `.json`, `.yaml`, `.toml`, etc. | Y.Text | CodeMirror (y-codemirror.next) | `Y.Text.toString()` (lossless, 1:1) |
| Binary (images, PDFs) | None | N/A | Blob references in files table, not Yjs documents |

### Why file-type-driven backing

No production system maintains both Y.Text and Y.XmlFragment on the same document with bidirectional sync. The markdown-to-structured-document conversion is inherently lossy (whitespace normalization, emphasis style, list markers). Continuous bidirectional sync creates normalization loops.

- **Y.XmlFragment** is required by y-prosemirror (ProseMirror needs a tree, not a flat sequence). Milkdown's `@milkdown/plugin-collab` wraps y-prosemirror internally.
- **Y.Text** maps 1:1 to CodeMirror characters. `Y.Text.toString()` gives exact file content. Zero conversion overhead.

### Content access

```typescript
type TextDocumentHandle = {
  type: 'text';
  fileId: string;
  ydoc: Y.Doc;
  content: Y.Text;
};

type RichTextDocumentHandle = {
  type: 'richtext';
  fileId: string;
  ydoc: Y.Doc;
  content: Y.XmlFragment;
  frontmatter: Y.Map<unknown>;  // YAML front matter fields (per-field LWW)
};

type DocumentHandle = TextDocumentHandle | RichTextDocumentHandle;

function openDocument(fileId: Guid, fileName: string): DocumentHandle {
  const ydoc = new Y.Doc({ guid: fileId, gc: false }); // fileId IS the GUID; gc: false for snapshots/versioning

  if (fileName.endsWith('.md')) {
    return {
      type: 'richtext',
      fileId,
      ydoc,
      content: ydoc.getXmlFragment('richtext'),
      frontmatter: ydoc.getMap('frontmatter'),
    };
  }
  return { type: 'text', fileId, ydoc, content: ydoc.getText('text') };
}
```

### Content doc GC strategy

- **Main doc** (files table): `gc: true`. LWW doesn't need CRDT history. Efficient.
- **Content docs**: `gc: false`. Retains tombstones for all deleted items, enabling Yjs snapshots for per-file version history. A snapshot is a state vector (`{ clientId → clock }`) that captures the document state at a point in time. Since tombstones are retained, any previous snapshot can be fully reconstructed — rollback to any version, play through the full history. Snapshots can be taken on every transaction for fine-grained history. Matches Google Drive's per-file revision model — no workspace-wide rollback, just individual file history.
- **Clear-and-rebuild writes (agent `writeFile` on `.md`)**: Each agent write tombstones all existing characters and inserts new ones. Snapshots still capture complete document state — rollback works perfectly. The only cost is storage growth (tombstones accumulate) and coarser diffs between snapshots (shows "everything deleted, everything re-inserted" instead of character-level changes). This does not affect rollback or version browsing — each snapshot is a complete, exact document state.

---

## Runtime Indexes

The files table is always in memory (it's on the main Y.Doc). Runtime indexes provide O(1) lookups for IFileSystem operations. They're ephemeral JS Maps — not stored in Yjs — rebuilt on load and updated incrementally via `files.observe()`.

```typescript
function createFileSystemIndex(filesTable: TableHelper<FileRow>) {
  // Path resolution
  const pathToId = new Map<string, string>();       // "/docs/api.md" → "abc-123"
  const idToPath = new Map<string, string>();        // "abc-123" → "/docs/api.md"

  // Tree traversal
  const childrenOf = new Map<string, string[]>();    // parentId → [childId, ...]

  // Content cache (for grep/search without loading content docs)
  const plaintext = new Map<string, string>();       // fileId → content string

  rebuild();
  filesTable.observe((changedIds) => update(changedIds));

  function rebuild() {
    // Walk all rows, compute paths, build children index
    const rows = filesTable.getAllValid();
    // Build path tree from parentId chains
    // For each directory, run disambiguateNames() on active children
    // to detect CRDT-concurrent duplicate names and assign display suffixes.
    // Index both clean and suffixed paths in pathToId/idToPath.
  }

  function update(changedIds: Set<string>) {
    // Incrementally update affected paths and children
    // Re-disambiguate siblings in affected parents (duplicate detection)
    // Invalidate plaintext cache for changed files
  }

  return { pathToId, idToPath, childrenOf, plaintext };
}

type FileSystemIndex = ReturnType<typeof createFileSystemIndex>;
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

### IFileSystem interface (exact just-bash contract)

just-bash's `IFileSystem` requires 21 methods (20 required + `readdirWithFileTypes` optional). The exact interface (from `just-bash@2.9.7/dist/fs/interface.d.ts`):

```typescript
interface IFileSystem {
  readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
  appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;  // optional
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  lstat(path: string): Promise<FsStat>;
  chmod(path: string, mode: number): Promise<void>;
  resolvePath(base: string, path: string): string;  // synchronous, two arguments
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  getAllPaths(): string[];  // for glob matching
}

interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: Date;
}
```

**Key differences from what you might expect:**
- `readFile` returns `string`, NOT `FileContent`. Binary reads use the separate `readFileBuffer`.
- `mv(src, dest)`, NOT `rename()`. This handles both moves and renames.
- `cp(src, dest, options?)`, NOT `copyFile`. Supports `{ recursive: true }` for directory copies.
- `resolvePath(base, path)` takes two arguments: a base path and a relative path.
- `readdirWithFileTypes` is optional (`?`) — implementations may omit it.
- `FsStat` has NO `birthtime` field — only `mtime`.
- No `watch()` method — just-bash does not require file watching.

### Root directory

The root directory (`/`) is a virtual entry — no row in the files table. Special-cased in all path operations:

```typescript
const ROOT_ID = '__ROOT__';  // sentinel, never stored in files table

// stat('/') returns a synthetic directory entry
// readdir('/') returns childrenOf.get(ROOT_ID) — children with parentId === null
// exists('/') returns true
// pathToId.set('/', ROOT_ID) during index build
```

Files with `parentId: null` are root-level children. The `childrenOf` index maps `ROOT_ID → [ids of files with parentId === null]`.

### Content doc pool

Content Y.Docs are managed by a pool with reference counting and on-demand loading:

```typescript
type ContentDocPool = {
  /** Get or create a content doc. Increments refcount. */
  acquire(fileId: string, fileName: string): DocumentHandle;
  /** Decrement refcount. Doc destroyed when refcount hits 0. */
  release(fileId: string): void;
  /** Get without incrementing refcount (for cache reads). Returns undefined if not loaded. */
  peek(fileId: string): DocumentHandle | undefined;
  /** Load a doc, populate plaintext cache, release immediately. For grep/search. */
  loadAndCache(fileId: string, fileName: string): string;
};

function createContentDocPool(
  connectProvider?: (ydoc: Y.Doc) => { destroy(): void },
): ContentDocPool {
  const docs = new Map<string, { handle: DocumentHandle; refcount: number; provider?: { destroy(): void } }>();

  return {
    acquire(fileId, fileName) {
      const existing = docs.get(fileId);
      if (existing) { existing.refcount++; return existing.handle; }

      const ydoc = new Y.Doc({ guid: fileId, gc: false });
      const provider = connectProvider?.(ydoc);
      const handle = openDocument(fileId, fileName);
      docs.set(fileId, { handle, refcount: 1, provider });
      return handle;
    },
    release(fileId) {
      const entry = docs.get(fileId);
      if (!entry) return;
      entry.refcount--;
      if (entry.refcount <= 0) {
        entry.provider?.destroy();
        entry.handle.ydoc.destroy();
        docs.delete(fileId);
      }
    },
    peek(fileId) {
      return docs.get(fileId)?.handle;
    },
    loadAndCache(fileId, fileName) {
      const handle = this.acquire(fileId, fileName);
      const text = documentHandleToString(handle);
      this.release(fileId);
      return text;
    },
  };
}
```

**Why reference counting**: Editors hold a reference while open. `grep -r` acquires, reads, releases. In the browser, only actively viewed files stay loaded (10-20 at a time). On the server, all docs can stay loaded (the server has memory for the full workspace).

**Provider connection model**: y-websocket uses one WebSocket per Y.Doc (no multiplexing). For the browser with 500 files, only the main doc + actively open content docs are connected (not all 500). The pool's `connectProvider` callback handles this — pass it for networked environments, omit it for in-memory testing.

### YjsFileSystem implementation

```typescript
class YjsFileSystem implements IFileSystem {
  constructor(
    private filesTable: TableHelper<FileRow>,
    private index: FileSystemIndex,
    private pool: ContentDocPool,
    private cwd: string = '/',
  ) {}

  // --- Reads (metadata only, always fast) ---

  async readdir(path: string): Promise<string[]> {
    const resolved = posixResolve(this.cwd, path);
    const id = this.resolveId(resolved);
    const childIds = this.index.childrenOf.get(id) ?? [];
    const activeChildren = childIds
      .map(cid => this.filesTable.get(cid).row!)
      .filter(row => row.trashedAt === null);
    const displayNames = disambiguateNames(activeChildren);
    return activeChildren.map(row => displayNames.get(row.id)!).sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const resolved = posixResolve(this.cwd, path);
    const id = this.resolveId(resolved);
    const childIds = this.index.childrenOf.get(id) ?? [];
    const activeChildren = childIds
      .map(cid => this.filesTable.get(cid).row!)
      .filter(row => row.trashedAt === null);
    const displayNames = disambiguateNames(activeChildren);
    return activeChildren.map(row => ({
      name: displayNames.get(row.id)!,
      isFile: row.type === 'file',
      isDirectory: row.type === 'folder',
      isSymbolicLink: false,
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  async stat(path: string): Promise<FsStat> {
    const resolved = posixResolve(this.cwd, path);
    if (resolved === '/') {
      return { isFile: false, isDirectory: true, isSymbolicLink: false,
        size: 0, mtime: new Date(0), mode: 0o755 };
    }
    const id = this.resolveId(resolved);
    const row = this.filesTable.get(id).row!;
    return {
      isFile: row.type === 'file',
      isDirectory: row.type === 'folder',
      isSymbolicLink: false,
      size: row.size,
      mtime: new Date(row.updatedAt),
      mode: row.type === 'folder' ? 0o755 : 0o644,
    };
  }

  async lstat(path: string): Promise<FsStat> {
    // No symlinks — lstat is identical to stat
    return this.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    const resolved = posixResolve(this.cwd, path);
    return resolved === '/' || this.index.pathToId.has(resolved);
  }

  // --- Reads (content, may load content doc) ---

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const resolved = posixResolve(this.cwd, path);
    const id = this.resolveId(resolved);
    const row = this.filesTable.get(id).row!;
    if (row.type === 'folder') throw fsError('EISDIR', resolved);

    // Fast path: plaintext cache
    const cached = this.index.plaintext.get(id);
    if (cached !== undefined) return cached;

    // Slow path: load content doc
    const text = this.pool.loadAndCache(id, row.name);
    this.index.plaintext.set(id, text);
    return text;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const text = await this.readFile(path);
    return new TextEncoder().encode(text);
  }

  // --- Writes (always through content doc for CRDT semantics) ---

  async writeFile(path: string, data: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const resolved = posixResolve(this.cwd, path);
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
    let id = this.index.pathToId.get(resolved);

    if (!id) {
      // Create file: parse path into parentId + name, ensure parent exists
      const { parentId, name } = this.parsePath(resolved);
      validateName(name);
      assertUniqueName(this.filesTable, this.index.childrenOf, parentId, name);
      id = generateGuid();
      this.filesTable.set({
        id, name, parentId, type: 'file',
        size: new TextEncoder().encode(content).byteLength,
        createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
      });
    }

    // Write content through Yjs
    const row = this.filesTable.get(id).row!;
    const handle = this.pool.acquire(id, row.name);
    try {
      if (handle.type === 'text') {
        handle.ydoc.transact(() => {
          handle.content.delete(0, handle.content.length);
          handle.content.insert(0, content);
        });
      } else {
        const { frontmatter, body } = parseFrontmatter(content);
        updateYMapFromRecord(handle.frontmatter, frontmatter);
        updateYXmlFragmentFromString(handle.content, body);
      }
    } finally {
      this.pool.release(id);
    }

    this.filesTable.update(id, {
      size: new TextEncoder().encode(content).byteLength,
      updatedAt: Date.now(),
    });
    this.index.plaintext.set(id, content);
  }

  async appendFile(path: string, data: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const resolved = posixResolve(this.cwd, path);
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const id = this.index.pathToId.get(resolved);
    if (!id) return this.writeFile(resolved, data, options);

    // Read existing content, append, and do a full write
    const existing = await this.readFile(resolved);
    await this.writeFile(resolved, existing + content);
  }

  // --- Structure ---

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const resolvedSrc = posixResolve(this.cwd, src);
    const resolvedDest = posixResolve(this.cwd, dest);
    const srcId = this.resolveId(resolvedSrc);
    const srcRow = this.filesTable.get(srcId).row!;

    if (srcRow.type === 'folder') {
      if (!options?.recursive) throw fsError('EISDIR', resolvedSrc);
      await this.mkdir(resolvedDest, { recursive: true });
      const children = await this.readdir(resolvedSrc);
      for (const child of children) {
        await this.cp(`${resolvedSrc}/${child}`, `${resolvedDest}/${child}`, options);
      }
    } else {
      const content = await this.readFile(resolvedSrc);
      await this.writeFile(resolvedDest, content);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const resolvedSrc = posixResolve(this.cwd, src);
    const resolvedDest = posixResolve(this.cwd, dest);
    const id = this.resolveId(resolvedSrc);
    const row = this.filesTable.get(id).row!;
    const { parentId: newParentId, name: newName } = this.parsePath(resolvedDest);
    validateName(newName);
    assertUniqueName(this.filesTable, this.index.childrenOf, newParentId, newName, id);

    // Detect extension category change and re-write content through new type
    if (row.type === 'file') {
      const fromCategory = getExtensionCategory(row.name);
      const toCategory = getExtensionCategory(newName);
      if (fromCategory !== toCategory) {
        const content = await this.readFile(resolvedSrc);
        this.index.plaintext.delete(id);
        this.filesTable.update(id, {
          name: newName, parentId: newParentId, updatedAt: Date.now(),
        });
        await this.writeFile(resolvedDest, content);
        return;
      }
    }

    this.filesTable.update(id, {
      name: newName, parentId: newParentId, updatedAt: Date.now(),
    });
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const resolved = posixResolve(this.cwd, path);
    if (await this.exists(resolved)) return; // mkdir on existing dir is a no-op

    const { parentId, name } = this.parsePath(resolved);
    validateName(name);

    // Recursive: create parent directories if they don't exist
    if (options?.recursive && parentId !== null) {
      const parentPath = resolved.substring(0, resolved.lastIndexOf('/')) || '/';
      if (!(await this.exists(parentPath))) {
        await this.mkdir(parentPath, { recursive: true });
      }
    }

    // Re-resolve parentId after potential recursive creation
    const { parentId: resolvedParentId } = this.parsePath(resolved);
    assertUniqueName(this.filesTable, this.index.childrenOf, resolvedParentId, name);
    this.filesTable.set({
      id: generateGuid(), name, parentId: resolvedParentId, type: 'folder',
      size: 0, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const resolved = posixResolve(this.cwd, path);
    const id = this.index.pathToId.get(resolved);
    if (!id) {
      if (options?.force) return;
      throw fsError('ENOENT', resolved);
    }
    const row = this.filesTable.get(id).row!;

    if (row.type === 'folder' && !options?.recursive) {
      const children = this.index.childrenOf.get(id) ?? [];
      const activeChildren = children.filter(cid => {
        const r = this.filesTable.get(cid).row;
        return r && r.trashedAt === null;
      });
      if (activeChildren.length > 0) throw fsError('ENOTEMPTY', resolved);
    }

    // Soft delete
    this.filesTable.update(id, { trashedAt: Date.now() });
    this.index.plaintext.delete(id);
  }

  // --- Permissions (no-op in collaborative system) ---

  async chmod(path: string, _mode: number): Promise<void> {
    // No-op. Permissions are derived (0o644 files, 0o755 dirs).
    // Silently succeed to satisfy just-bash commands that call chmod.
    const resolved = posixResolve(this.cwd, path);
    this.resolveId(resolved); // throws ENOENT if path doesn't exist
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const resolved = posixResolve(this.cwd, path);
    const id = this.resolveId(resolved);
    this.filesTable.update(id, { updatedAt: mtime.getTime() });
  }

  // --- Symlinks / Links (not supported) ---

  async symlink(): Promise<void> { throw fsError('ENOSYS', 'symlinks not supported'); }
  async link(): Promise<void> { throw fsError('ENOSYS', 'hard links not supported'); }
  async readlink(): Promise<string> { throw fsError('ENOSYS', 'symlinks not supported'); }

  // --- Path resolution ---

  resolvePath(base: string, path: string): string {
    return posixResolve(base, path);
  }

  async realpath(path: string): Promise<string> {
    // No symlinks, so realpath is just path normalization + existence check
    const resolved = posixResolve(this.cwd, path);
    if (!(await this.exists(resolved))) throw fsError('ENOENT', path);
    return resolved;
  }

  getAllPaths(): string[] {
    return Array.from(this.index.pathToId.keys()).filter(p => p !== '/');
  }

  // --- Private helpers ---

  private resolveId(path: string): string {
    if (path === '/') return ROOT_ID;
    const id = this.index.pathToId.get(path);
    if (!id) throw fsError('ENOENT', path);
    return id;
  }

  private parsePath(path: string): { parentId: string | null; name: string } {
    const normalized = posixResolve(this.cwd, path);
    const lastSlash = normalized.lastIndexOf('/');
    const name = normalized.substring(lastSlash + 1);
    const parentPath = normalized.substring(0, lastSlash) || '/';
    if (parentPath === '/') return { parentId: null, name };
    const parentId = this.index.pathToId.get(parentPath);
    if (!parentId) throw fsError('ENOENT', parentPath);
    return { parentId, name };
  }
}
```

### Agent integration

```typescript
import { Bash } from 'just-bash';

const index = createFileSystemIndex(client.tables.files);
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
| `mv /old /new` | `mv()` → 1 row update in files table | O(1) |
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

**Decision: Y.XmlFragment + Y.Map for `.md`, Y.Text for everything else. Three root-level keys (`'text'`, `'richtext'`, `'frontmatter'`) so all types can coexist on the same doc.**

- y-prosemirror requires Y.XmlFragment (ProseMirror needs a tree structure)
- y-codemirror.next requires Y.Text (1:1 character mapping)
- Y.Map is the natural CRDT type for front matter — per-field last-writer-wins, concurrent edits to different metadata fields merge cleanly
- No production system successfully syncs both representations bidirectionally
- File extension determines the active types — it rarely changes, but when it does (rename), convert-on-switch migrates content between types

### Triple keys with convert-on-switch (content type switching)

**Decision: Each content doc uses three root-level keys — `'text'` (Y.Text), `'richtext'` (Y.XmlFragment), and `'frontmatter'` (Y.Map). Active keys depend on file extension: `.md` uses `'richtext'` + `'frontmatter'`; code/txt files use `'text'` only.**

**Why separate keys, not a shared `'content'` key**: Yjs permanently locks a root-level key to whichever shared type is accessed first. If a doc calls `getText('content')`, that key is bound to Y.Text forever — calling `getXmlFragment('content')` on the same doc throws. Separate keys allow both types to coexist, enabling type switching without destroying the document.

**Key names**: `'text'` and `'richtext'` mirror the `type` discriminator in `DocumentHandle`. `'frontmatter'` stores structured YAML metadata for `.md` files. They describe what the data represents (content format), not the Yjs type that stores it.

**Lazy key creation:** Keys are created in Yjs only when first accessed via `getXmlFragment()`, `getText()`, or `getMap()`. The `openDocument()` function only accesses the active keys for the current file type. A `.ts` file that was never renamed has exactly one key (`Y.Text('text')`) in its doc state — the `richtext` and `frontmatter` keys don't exist at all until a conversion happens. There is zero overhead for the common case (files that never change type).

**Convert-on-switch flow:**

Rename `.txt` → `.md`:
1. Read current text: `ydoc.getText('text').toString()`
2. Parse front matter: extract `---` delimited YAML and body via `parseFrontmatter()`
3. Store front matter fields in `ydoc.getMap('frontmatter')` via `updateYMapFromRecord()`
4. Apply body to `ydoc.getXmlFragment('richtext')` via `updateYXmlFragmentFromString()` (clear-and-rebuild)
5. Active keys are now `getXmlFragment('richtext')` + `getMap('frontmatter')`

Rename `.md` → `.txt`:
1. Serialize front matter: `yMapToRecord(ydoc.getMap('frontmatter'))` → YAML string
2. Serialize body: `remarkSerialize(ydoc.getXmlFragment('richtext'))` → markdown string
3. Combine: `serializeMarkdownWithFrontmatter(frontmatter, body)` — prepends `---\n{yaml}\n---\n` if front matter is non-empty
4. Replace `ydoc.getText('text')` with the combined string via `updateYTextFromString()`
5. Active key is now `getText('text')`

**State progression across renames:**

```
Y.Doc(guid: "bbb-222")

  ── Phase 1: created as api.md ─────────────────────────────────────
  │ Y.XmlFragment('richtext')  → <p>Hello world</p>     │ ACTIVE
  │ Y.Map('frontmatter')       → { title: "API Ref" }   │ ACTIVE
  │ Y.Text('text')             →  (does not exist yet)   │ never accessed
  └──────────────────────────────────────────────────────┘
  Only 2 keys in doc state. Y.Text('text') was never called,
  so it doesn't exist in the Yjs internal structures at all.

  ── Phase 2: renamed to api.ts (convert richtext→text) ────────────
  │ Y.Text('text')             → "---\ntitle: API Ref   │ ACTIVE
  │                               \n---\nHello world"    │
  │ Y.XmlFragment('richtext')  → <p>Hello world</p>     │ stale
  │ Y.Map('frontmatter')       → { title: "API Ref" }   │ stale
  └──────────────────────────────────────────────────────┘
  Y.Text created during conversion. Old keys remain but are
  never read — the file extension determines which keys are active.

  ── Phase 3: edited as .ts in CodeMirror ───────────────────────────
  │ Y.Text('text')             → "export const x = 42;" │ ACTIVE (edited)
  │ Y.XmlFragment('richtext')  → <p>Hello world</p>     │ stale (now WRONG)
  │ Y.Map('frontmatter')       → { title: "API Ref" }   │ stale (now WRONG)
  └──────────────────────────────────────────────────────┘
  Stale keys diverge from reality. This is fine — they are never
  read while the file is .ts. Correctness depends only on the
  active key, never on stale keys.

  ── Phase 4: renamed back to api.md (convert text→richtext) ───────
  │ Y.XmlFragment('richtext')  → <p>export const x …</p>│ ACTIVE (fresh)
  │ Y.Map('frontmatter')       → {}                     │ ACTIVE (fresh)
  │ Y.Text('text')             → "export const x = 42;" │ stale
  └──────────────────────────────────────────────────────┘
  Conversion reads from Y.Text (the truth), parses, and OVERWRITES
  the stale richtext/frontmatter. The old stale data is gone.
  Stale data never causes correctness issues because conversions
  always read from the active type and overwrite the target type.
```

**Comparison: file that never changes type (common case):**

```
  Y.Doc(guid: "ccc-333")     ← index.ts, never renamed
  ┌──────────────────────────────────────────────────────┐
  │ Y.Text('text')  → "export function main() { … }"    │ ACTIVE
  └──────────────────────────────────────────────────────┘
  One key. No richtext, no frontmatter. Zero overhead.

  Y.Doc(guid: "ddd-444")     ← notes.md, never renamed
  ┌──────────────────────────────────────────────────────┐
  │ Y.XmlFragment('richtext')  → <p>Meeting notes…</p>  │ ACTIVE
  │ Y.Map('frontmatter')       → { date: "2026-02-09" } │ ACTIVE
  └──────────────────────────────────────────────────────┘
  Two keys. No text. Zero overhead.
```

**Properties:**
- Rename remains a metadata operation (files table) + content migration — same Y.Doc, same GUID, no orphaned docs
- Inactive keys only exist after a conversion has occurred — the common case (no type change) has exactly the keys it needs, nothing more
- Stale data is never read and is always overwritten on the next conversion — correctness depends only on the active keys
- Front matter survives format conversion: `.txt` → `.md` extracts front matter from text into structured Y.Map fields; `.md` → `.txt` serializes Y.Map fields back into YAML text
- Round-trip is inherently lossy (markdown ↔ structured tree) — this matches reality of format conversion
- No bidirectional sync — only one type is active at a time, avoiding the normalization loops that plague dual-representation systems

### Observer-side editor swap on type-changing rename

**Decision: Observing peers tear down and rebind their editor when they detect a type-changing rename — same as any editor reloading a buffer after an external change.**

The renaming peer performs the convert-on-switch data migration (reads old active keys, writes new active keys). Observing peers don't need to migrate anything — they detect the type change via `files.observe()` and rebind their editor to the already-migrated content. This mirrors standard editor behavior: Neovim, VS Code, and every file editor reload the buffer when the file type changes externally.

**Observer-side flow:**

```
Peer A (renaming peer)             Peer B (observing peer)
──────────────────────             ─────────────────────────
1. files.update(name: "api.md")
2. Read Y.Text('text')
3. Parse frontmatter
4. Write Y.XmlFragment + Y.Map
                              ──→  1. files.observe() fires
                                   2. Detect extension change (.txt → .md)
                                   3. Tear down CodeMirror (unbind from Y.Text)
                                   4. Read from Y.XmlFragment + Y.Map
                                      (already populated by Peer A)
                                   5. Bind ProseMirror to Y.XmlFragment
```

**Extension change categories:**

| Change | Action |
|--------|--------|
| Category change (`.txt` → `.md`, `.md` → `.ts`) | Tear down editor, rebind to new active keys |
| Same category (`.ts` → `.js`, `.py` → `.rs`) | No editor swap — update syntax highlighting only |
| No extension change (rename `foo.md` → `bar.md`) | No editor swap — same active keys |

**No incremental migration on the observing side.** The renaming peer writes to the new active keys. Observing peers just rebind. Editor state (cursor position, scroll, selection, undo history) is lost on swap — acceptable for the rare event of a type-changing rename.

**Cross-doc timing.** The rename (main doc) and content migration (content doc) propagate through independent sync channels. An observing peer may receive the rename before the migration arrives. This resolves naturally — y-prosemirror and y-codemirror handle external mutations to the shared types they're bound to. If the target type is empty (first-ever conversion) or contains stale data (re-conversion), the editor binds to that state and then updates when the migration arrives. Worst case: a brief flash of empty or stale content, comparable to VS Code reloading a file after an external change.

**Self-healing.** If the renaming peer crashes between rename and migration, the file has a new extension but the target content type is empty or stale. Any peer opening the file can detect this: the extension says `.md` but `Y.XmlFragment('richtext')` is empty while `Y.Text('text')` has content (or vice versa). That peer runs the migration itself — read from the populated type, write to the empty type. `openDocument()` is the natural place for this check. No stuck states.

### Alternatives considered for content type storage

**New doc per type change:** On rename, create a new Y.Doc with a new GUID, migrate content, update a `contentDocGuid` field on the file row. Each doc is "clean" (no stale keys). But this breaks the `fileId = docGuid` invariant — every file row now needs a separate `contentDocGuid` field. Version history is split across multiple doc GUIDs (no continuity). Orphaned docs need provider-level garbage collection. The clean 1:1 mapping between file IDs and doc GUIDs is too valuable to sacrifice for cosmetic key cleanliness.

**Always Y.Text, derive rich editing:** Store everything as Y.Text regardless of type. For `.md` files, parse into ProseMirror on open, sync edits back to Y.Text via serialize → diff → apply. One key, one type, no conversion on rename. But this is bidirectional sync: ProseMirror edit → serialize to markdown → diff against Y.Text → apply Yjs ops. The round-trip normalizes whitespace, emphasis style, list markers. Two concurrent editors get normalization loops where each peer's serialization "corrects" the other's formatting. No production system has solved this.

**Versioned key names:** Use `'text:1'`, `'richtext:2'`, `'frontmatter:2'` with a `contentVersion` counter. Every conversion creates fresh keys, so no stale data confusion. But keys accumulate forever (10 renames = 10 sets of keys), requires a version counter in metadata, and gains nothing over triple-key — stale keys in the triple-key approach are equally harmless and get overwritten on the next conversion instead of accumulating indefinitely.

### Front matter as Y.Map (structured metadata for .md files)

**Decision: Store front matter in `Y.Map('frontmatter')` with top-level YAML keys as map entries.**

Front matter is YAML metadata at the top of markdown files:

```markdown
---
title: Hello World
date: 2026-02-09
tags: [tutorial, getting-started]
---

Body content here.
```

**Y.Map properties:**
- **Per-field LWW**: Each top-level YAML key is a Y.Map entry. Concurrent edits to different fields merge cleanly (user A changes `title`, user B changes `tags` — both apply).
- **JSON-compatible values**: Y.Map entries store strings, numbers, booleans, arrays, and nested objects — matching YAML's value space. Nested structures are stored as opaque JSON values (LWW at the top-level key, not deep-merged).
- **Separate from body**: ProseMirror's document tree represents body content only. Front matter is not rendered as ProseMirror nodes. This avoids schema complexity and keeps the XmlFragment clean.

**Why not store front matter in the Y.XmlFragment:**
- ProseMirror schemas are designed for document content. Front matter is metadata, not content.
- Agents editing front matter would need to understand the ProseMirror tree structure rather than simple key-value writes.
- Mixing metadata into the document tree couples the serializer to a YAML library.

**Why not store front matter in Y.Text:**
- Y.Text is a flat character sequence. Concurrent edits to different YAML keys could interleave characters, producing invalid YAML.
- Y.Map gives per-field conflict resolution — the correct granularity for structured metadata.

**Read path**: `Y.Map.forEach()` → `Record<string, unknown>` → `yamlStringify()` → prepend to body with `---` delimiters.

**Write path**: Parse `---` delimiters → `yamlParse()` → `Record<string, unknown>` → `updateYMapFromRecord()` (diff-updates the Y.Map: add new keys, update changed keys, delete missing keys).

**Editor integration**: The UI renders front matter as a structured form (text fields, tag editors) bound directly to Y.Map entries. Changes propagate via Y.Map observers, not ProseMirror transactions. Independent of the rich text editor.

**Helper functions:**

```typescript
/** Parse a markdown string into front matter record + body string */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) return { frontmatter: {}, body: content };
  const yaml = content.slice(4, endIndex);
  const body = content.slice(endIndex + 5);
  return { frontmatter: yamlParse(yaml), body };
}

/** Diff-update a Y.Map to match a target record. Per-field LWW. */
function updateYMapFromRecord(ymap: Y.Map<unknown>, target: Record<string, unknown>): void {
  const doc = ymap.doc!;
  doc.transact(() => {
    // Delete keys not in target
    ymap.forEach((_, key) => {
      if (!(key in target)) ymap.delete(key);
    });
    // Set/update keys from target
    for (const [key, value] of Object.entries(target)) {
      const current = ymap.get(key);
      if (!deepEqual(current, value)) ymap.set(key, value);
    }
  });
}

/** Combine front matter and body into a markdown string with --- delimiters */
function serializeMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${yamlStringify(frontmatter)}---\n${body}`;
}

/** Convert Y.Map to a plain Record */
function yMapToRecord(ymap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  ymap.forEach((value, key) => { result[key] = value; });
  return result;
}
```

### Agent writes on .md files: clear-and-rebuild

**Approach**: Agent `writeFile` on `.md` files uses clear-and-rebuild via `updateYXmlFragmentFromString()`. This deletes all XmlFragment nodes and rebuilds from the parsed markdown in a single Yjs transaction. Every character loses its Yjs item ID on each write.

**Revision history is fully functional.** Content docs use `gc: false`, so tombstones from clear-and-rebuild are retained. Snapshots taken before and after an agent write capture complete document states. Rollback to any snapshot reconstructs the exact document. The only difference from character-level diffs: the diff *between* two snapshots shows "everything deleted, everything re-inserted" rather than highlighting the specific changes. The snapshots themselves are perfect — browsing history and restoring versions works identically to code files with character-level diffs.

**Concurrent editing limitation.** If a human is editing in ProseMirror while an agent calls `writeFile`, the agent's clear-and-rebuild destroys the human's in-flight CRDT operations. Non-overlapping edits are lost because every character is deleted and re-inserted with new IDs. This is the primary cost of clear-and-rebuild — not revision history, but concurrent writer safety.

**Storage cost.** Each agent write creates tombstones for every existing character plus new items for every inserted character. A 5KB markdown file with 20 agent writes accumulates ~200KB of Yjs state. Manageable for local-first storage, and compaction (snapshot → fresh doc) can reclaim space if needed.

**Future optimization: `updateYFragment`.** Replace clear-and-rebuild internals with y-prosemirror's `updateYFragment()`. This diffs a ProseMirror node tree against the existing Y.XmlFragment, preserving unchanged paragraphs and applying character-level diffs within modified text nodes. Requires a headless ProseMirror schema matching Milkdown's schema plus a `markdownToProseMirrorNode()` parse function. Adopt when concurrent human + agent editing on `.md` files is a real workflow. The architectural change is contained to a single function's internals — no API changes needed.

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
- Per-file snapshots via Yjs (content docs use `gc: false`) provide complete version history per file. Snapshots can be taken on every transaction. Each snapshot reconstructs the exact document state at that point — rollback and history playback work for all file types, including `.md` files with clear-and-rebuild agent writes
- Main doc uses `gc: true` for efficient LWW

### Soft delete (co-located `trashedAt`)

**Decision: `trashedAt: number | null` field on the file row. `null` = active, timestamp = when trashed.**

- Soft delete prevents accidental data loss in a collaborative system where one user's `rm` affects everyone
- Co-located on the row (not a separate trash table) for simplicity — one lookup, one table, restore preserves the entire row (parentId, name, everything)
- `readdir()` and `readdirWithFileTypes()` filter out trashed files — trashed files are invisible to IFileSystem/bash operations
- Permanent delete = `files.delete(id)`, same as before
- LWW conflict with concurrent metadata edits is the same risk as any other field — if someone trashes a file while someone else renames it, one wins. In practice this is rare and the consequence is mild (trash it again)
- `rm` via IFileSystem soft-deletes (sets `trashedAt`). In a collaborative system, an agent's `rm` shouldn't permanently destroy data that other users may need. Permanent delete is an explicit "empty trash" UI operation

### Name validation

**Decision: `name` must not contain `/`, `\`, or null bytes (`\0`). All other characters are allowed.**

- Path resolution joins names with `/` to build paths like `/docs/api.md`. A file named `foo/bar` in `/docs/` produces the path `/docs/foo/bar`, which is ambiguous with a file named `bar` in `/docs/foo/`
- Every real filesystem enforces this — ext4 and APFS forbid `/` in filenames at the kernel level, NTFS forbids `\ / : * ? " < > |`
- We only enforce the minimum: path separators and null bytes. Spaces, dots, unicode, emoji, special characters are all allowed
- Validation happens on write (`writeFile`, `mkdir`, rename operations) — reject with `EINVAL` before touching Yjs

```typescript
function validateName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw fsError('EINVAL', `invalid filename: ${name}`);
  }
  if (name === '' || name === '.' || name === '..') {
    throw fsError('EINVAL', `reserved filename: ${name}`);
  }
}
```

### Name uniqueness (EEXIST on write + display disambiguation for CRDT conflicts)

**Decision: Enforce unique `(parentId, name)` on local writes. Disambiguate at the IFileSystem read layer for concurrent CRDT conflicts.**

Real filesystems (ext4, APFS, NTFS) enforce unique filenames per directory at the kernel level. Google Drive does not — it allows multiple files with the same name in the same folder because Drive never exposes path-based access (everything is by ID). We need both: ID-based storage (like Drive) and path-based access (IFileSystem for bash). So uniqueness is enforced at two layers:

**Layer 1: EEXIST check on local writes.** All operations that create or rename a file (`writeFile` creating new, `mkdir`, rename, move) check if an active (non-trashed) file with the same `(parentId, name)` already exists. If so, reject with `EEXIST`. This prevents 99% of duplicates — the single-user and non-concurrent cases.

```typescript
function assertUniqueName(
  filesTable: TableHelper<FileRow>,
  childrenOf: Map<string, string[]>,
  parentId: string | null,
  name: string,
  excludeId?: string, // for rename/move: exclude the file being operated on
): void {
  const siblingIds = childrenOf.get(parentId ?? 'ROOT') ?? [];
  const duplicate = siblingIds.find(id => {
    if (id === excludeId) return false;
    const row = filesTable.get(id).row;
    return row && row.name === name && row.trashedAt === null;
  });
  if (duplicate) {
    throw fsError('EEXIST', `${name} already exists in parent`);
  }
}
```

**Layer 2: Display disambiguation for CRDT conflicts.** Two users can simultaneously create files with the same name — each generates a unique Guid, inserts a row with the same `(parentId, name)`. Both writes succeed independently via LWW (different IDs). The stored `name` is NOT mutated. Instead:

- The IFileSystem layer detects duplicate names at read time (`readdir`, `readdirWithFileTypes`, path index rebuild)
- Assigns display suffixes: `foo.txt` stays for the earliest-created file, `foo (1).txt` for the next, `foo (2).txt` for subsequent duplicates
- Ordering by `createdAt` is deterministic and stable across all peers
- `pathToId` indexes both the clean path and suffixed paths, so `cat /docs/foo (1).txt` resolves correctly
- The UI can surface name conflicts and let users rename manually

```typescript
function disambiguateNames(rows: FileRow[]): Map<string, string> {
  // Returns fileId → displayName
  const result = new Map<string, string>();
  const byName = new Map<string, FileRow[]>();

  for (const row of rows) {
    const group = byName.get(row.name) ?? [];
    group.push(row);
    byName.set(row.name, group);
  }

  for (const [name, group] of byName) {
    if (group.length === 1) {
      result.set(group[0].id, name);
      continue;
    }
    // Sort by createdAt — earliest keeps clean name
    group.sort((a, b) => a.createdAt - b.createdAt);
    result.set(group[0].id, name);
    for (let i = 1; i < group.length; i++) {
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      result.set(group[i].id, `${base} (${i})${ext}`);
    }
  }
  return result;
}
```

**Why not auto-rename in metadata:** Auto-renaming writes back to the CRDT, which can itself conflict with other concurrent operations. Clock skew across peers makes "later" ambiguous. Silently renaming a file someone just created is surprising. Display-only disambiguation avoids all write-back issues — it's purely a read-layer concern.

**Why not reject on observe:** The CRDT has already accepted both writes. Deleting one would lose data. The correct CRDT philosophy: accept all data, present it coherently.

---

## Operations

### Create File
1. Validate name (no `/`, `\`, null bytes, empty, `.`, `..`)
2. Assert unique name in parent (`assertUniqueName` — reject with `EEXIST` if duplicate)
3. Generate ID
4. `files.set({ id, name, parentId, type: 'file', size: 0, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null })`
5. Content Y.Doc created lazily when first opened

### Create Folder
1. Validate name
2. Assert unique name in parent (`assertUniqueName` — reject with `EEXIST` if duplicate)
3. Generate ID
4. `files.set({ id, name, parentId, type: 'folder', size: 0, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null })`

### Move File/Folder
1. Assert unique name in new parent (`assertUniqueName` with `excludeId` — reject with `EEXIST` if duplicate)
2. `files.update(id, { parentId: newParentId, updatedAt: Date.now() })`
3. Runtime indexes update reactively via `files.observe()`
4. No cascading updates — children still reference this node by ID

### Rename
**Renaming peer:**
1. Validate new name
2. Assert unique name in parent (`assertUniqueName` with `excludeId` — reject with `EEXIST` if duplicate)
3. `files.update(id, { name: newName, updatedAt: Date.now() })`
4. If file extension category changed (e.g., `.txt` → `.md` or `.md` → `.txt`):
   a. Load content doc
   b. Serialize from old active type → populate new active type (convert-on-switch, including front matter migration)
   c. Invalidate plaintext cache
   d. Tear down current editor binding, rebind to new active keys

**Observing peers (via `files.observe()`):**
1. Detect `name` field changed on the file row
2. If extension category unchanged: update syntax highlighting, rebuild path indexes. Done.
3. If extension category changed (code/txt ↔ .md):
   a. Tear down current editor binding (unbind y-codemirror or y-prosemirror)
   b. Read from new active keys (already migrated by renaming peer)
   c. Bind new editor to the new active keys
   d. Invalidate plaintext cache

### Trash (IFileSystem `rm` and UI)
1. `files.update(id, { trashedAt: Date.now() })`
2. File/folder becomes invisible to `readdir()` and path resolution
3. Content Y.Doc remains loaded if open — editor can show "this file was trashed" state
4. Children of trashed folders are implicitly trashed (parent is invisible, so children are unreachable) — no recursive walk needed, O(1)

### Restore from Trash (UI-layer)
1. `files.update(id, { trashedAt: null })`
2. If original parent was permanently deleted, reset `parentId` to `null` (restore to root)
3. File reappears in `readdir()` and path resolution

### Delete (permanent, "empty trash" UI only)
1. `files.delete(id)`
2. Recursively delete children via `childrenOf` index
3. Content Y.Docs become orphaned (provider garbage-collects)
4. Plaintext cache entries evicted

### Read File Content
1. Resolve path to ID via `pathToId` index
2. Check plaintext cache — return if cached
3. Load content Y.Doc. For code files: `Y.Text.toString()`. For `.md` files: serialize `Y.Map('frontmatter')` → YAML + serialize `Y.XmlFragment('richtext')` → markdown body + combine with `---` delimiters. Cache and return.

### Write File Content
1. Resolve path to ID (or create file if new)
2. Load content Y.Doc
3. For code files: apply changes via Yjs transaction on Y.Text. For `.md` files: extract front matter → `updateYMapFromRecord()` on Y.Map, apply body via `updateYXmlFragmentFromString()` on Y.XmlFragment (clear-and-rebuild).
4. Update `size` and `updatedAt` on files table row
5. Update plaintext cache

### List Children
1. `childrenOf.get(folderId)` for child IDs
2. Filter out rows where `trashedAt !== null`
3. Run `disambiguateNames()` to assign display names (handles CRDT duplicate conflicts)
4. Map to rows using display names (sort applied at the application layer — `ls` sorts by name, time, size, etc.)

### Resolve Path
1. Look up in `pathToId` index (O(1))
2. On cache miss: walk `parentId` chain from target to root, build path

---

## Validation

### Name validation

All operations that set a filename (`writeFile`, `mkdir`, rename) must validate the name before writing to Yjs:

- Must not contain `/`, `\`, or `\0` (path separator ambiguity, null byte safety)
- Must not be empty, `.`, or `..` (reserved POSIX names)
- All other characters are allowed (spaces, dots, unicode, emoji, special characters)

### Duplicate name detection

Duplicate `(parentId, name)` pairs among active files can arise from concurrent CRDT writes that bypass the local `EEXIST` check. Detection and disambiguation happen at two points:

**On index rebuild/update (`files.observe()`):** When building the `pathToId` and `idToPath` indexes, group active children by `(parentId, name)`. For groups with >1 entry, assign display suffixes using `disambiguateNames()` — earliest `createdAt` keeps the clean path, later entries get suffixed paths. Both clean and suffixed paths are indexed in `pathToId`.

**On `readdir()` / `readdirWithFileTypes()`:** Return display names (with suffixes) instead of raw stored names when duplicates exist within the listed directory.

The UI layer can detect duplicates via the same grouping logic and surface a "name conflict" indicator, prompting users to rename one of the files. Once renamed, the disambiguation suffix disappears automatically on the next index rebuild.

### Circular reference detection

Concurrent moves can create cycles (user A moves folder X into folder Y while user B moves folder Y into folder X). Since Yjs resolves each move independently via LWW, both moves can succeed, creating a cycle.

Detection: after any `parentId` change observed via `files.observe()`, walk the `parentId` chain from the moved node. If the chain exceeds a reasonable depth (e.g., 50) or revisits a node, break the cycle by resetting the later-timestamped move's `parentId` to null (move to root).

### Orphan detection

If a file's `parentId` references a permanently deleted folder, the file is orphaned. On index rebuild, detect orphans and surface them at root level (`parentId = null`) as the safe default.

Note: trashed folders don't create orphans — their children are implicitly unreachable via `readdir()` (which filters by `trashedAt`). Orphans only occur from permanent deletes, which remove the row entirely.

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

## Implementation Phases

### Existing foundation

The static API is production-ready and provides the core building blocks:

| What | Location | Use |
|------|----------|-----|
| `defineTable()` | `packages/epicenter/src/static/define-table.ts` | Define the `files` table schema |
| `defineWorkspace()` | `packages/epicenter/src/static/define-workspace.ts` | Define the filesystem workspace |
| `createWorkspace()` | `packages/epicenter/src/static/create-workspace.ts` | Instantiate the workspace (sync, returns table helpers) |
| `TableHelper` | `packages/epicenter/src/static/table-helper.ts` | CRUD on files table: `set()`, `get()`, `update()`, `delete()`, `observe()`, `filter()`, `find()` |
| `Guid` / `generateGuid()` | `packages/epicenter/src/dynamic/schema/fields/id.ts` | File IDs (15-char nanoid, globally unique, doubles as Y.Doc GUID) |
| YKeyValueLww | `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts` | Row-level LWW storage backing the files table |
| Extensions | `packages/epicenter/src/extensions/` | Pluggable persistence (IndexedDB/SQLite) and sync (y-sweet, WebSocket) |

**Already installed**: `yjs@^13.6.27`, `y-indexeddb`, `y-websocket`, `@y-sweet/client`, `nanoid`, `arktype`

**Not installed (add as needed per phase)**: `just-bash`, `y-codemirror.next`, `milkdown`, `y-prosemirror`, `@milkdown/plugin-collab`

### Phase 1: Files table + runtime indexes

**Goal**: Define the files table, build runtime indexes, implement `createFileSystemIndex()`.

**Deliverables**:
1. Files table definition using `defineTable()` with the schema from Layer 1
2. `createFileSystemIndex()` — builds `pathToId`, `idToPath`, `childrenOf`, `plaintext` Maps from the files table
3. Incremental index updates via `filesTable.observe()`
4. `validateName()`, `assertUniqueName()`, `disambiguateNames()` helper functions
5. Circular reference detection and orphan detection in index rebuild

**Tests**: Unit tests for index building, path resolution, name validation, disambiguation, circular reference breaking.

**No dependencies to add.** Everything needed is in the static API.

### Phase 2: IFileSystem + just-bash integration

**Goal**: Implement `YjsFileSystem` class with all 17 IFileSystem methods. Text-only files (Y.Text) first.

**Deliverables**:
1. Install `just-bash`
2. `YjsFileSystem` class implementing the full `IFileSystem` contract:
   - Reads: `readFile()`, `readFileBuffer()`, `readdir()`, `readdirWithFileTypes()`, `stat()`, `exists()`
   - Writes: `writeFile()`, `appendFile()`
   - Structure: `mkdir()` (with `recursive`), `rm()`, `cp()` (with `recursive`), `mv()`
   - Path: `resolvePath()`, `realpath()`
   - Other: `chmod()` (no-op), `symlink()`/`link()`/`readlink()` (ENOSYS), `lstat()`, `utimes()`, `getAllPaths()`
3. `createContentDocPool()` — reference-counted content doc lifecycle with optional provider connection
4. Root directory handling (`/` as virtual entry, `ROOT_ID` sentinel)
5. Plaintext cache population on `readFile()`, invalidation on write

**Scope limitation**: All files use `Y.Text` in this phase. No markdown/XmlFragment support yet. Treat `.md` files as plain text temporarily.

**Tests**: Populate `YjsFileSystem`, pass to `new Bash({ fs: yjsFs })`, run just-bash test scripts against it. Target: `ls`, `cat`, `find`, `grep`, `mkdir -p`, `rm -rf`, `mv`, `cp -r` all passing.

### Phase 3: Markdown support (Y.XmlFragment + Y.Map)

**Goal**: Add `.md` file support with Y.XmlFragment for body and Y.Map for frontmatter.

**Headless serialization decision (resolved)**: Use `prosemirror-markdown` + `y-prosemirror` for headless serialization. Both are DOM-free and work in Node.js without jsdom.

- `y-prosemirror`'s `yXmlFragmentToProsemirrorJSON()` converts Y.XmlFragment → ProseMirror JSON (zero DOM calls)
- `prosemirror-model`'s `Node.fromJSON(schema, json)` creates ProseMirror nodes from JSON (platform-agnostic)
- `prosemirror-markdown`'s `defaultMarkdownSerializer.serialize(doc)` converts ProseMirror → markdown string (no DOM)
- `prosemirror-markdown`'s `defaultMarkdownParser.parse(markdown)` converts markdown → ProseMirror (uses markdown-it internally, 30x faster than remark)

The same ProseMirror schema must be shared between the headless pipeline (this phase) and the editor (Phase 5). Use `prosemirror-markdown`'s CommonMark schema as the source of truth.

**Dependencies to add**: `y-prosemirror`, `prosemirror-model`, `prosemirror-markdown`, `prosemirror-schema-basic`

**Deliverables**:
1. `parseFrontmatter(content)` — split `---` delimited YAML from body
2. `serializeMarkdownWithFrontmatter(frontmatter, body)` — combine YAML + body
3. `updateYMapFromRecord(ymap, target)` — diff-update Y.Map from plain object
4. `yMapToRecord(ymap)` — Y.Map to plain object
5. `serializeXmlFragmentToMarkdown(fragment)` — headless pipeline:
   - `yXmlFragmentToProsemirrorJSON(fragment)` → ProseMirror JSON
   - `Node.fromJSON(schema, json)` → ProseMirror doc
   - `defaultMarkdownSerializer.serialize(doc)` → markdown string
6. `updateYXmlFragmentFromString(fragment, markdownBody)` — headless pipeline:
   - `defaultMarkdownParser.parse(markdown)` → ProseMirror doc
   - `prosemirrorJSONToYXmlFragment(schema, doc.toJSON(), fragment)` → updates Y.XmlFragment (clear-and-rebuild)
7. Update `openDocument()` to return `RichTextDocumentHandle` for `.md` files
8. Update `readFile()` and `writeFile()` to handle the richtext path

**Tests**: Round-trip tests: write markdown string → readFile → compare. Frontmatter parsing/serialization. Y.Map diff-update correctness. Headless XmlFragment ↔ markdown serialization in Node.js (no DOM).

### Phase 4: Convert-on-switch

**Goal**: Implement content migration when file extension category changes on rename.

**Deliverables**:
1. Extension category detection: `getExtensionCategory(name)` → `'text' | 'richtext'`
2. Convert-on-switch in rename operation: read from old active type, write to new active type
3. Self-healing in `openDocument()`: detect mismatched extension vs. content, trigger migration if needed
4. Observer-side editor swap: `files.observe()` handler that detects category-changing renames and triggers editor teardown/rebind

**Tests**: Rename `.txt` → `.md` and verify content migrated correctly. Rename `.md` → `.ts` and verify serialization. Round-trip rename and verify content integrity. Self-healing: create a doc with wrong-category content, open it, verify migration runs.

### Phase 5: Editor bindings (UI layer)

**Goal**: Wire up collaborative editors in the Tauri app.

**Deliverables**:
1. Install `y-codemirror.next`, `@milkdown/plugin-collab`
2. CodeMirror 6 component bound to `Y.Text` via `yCollab()`
3. Milkdown editor bound to `Y.XmlFragment` via `@milkdown/plugin-collab`
4. Frontmatter UI bound to `Y.Map` entries (structured form, not ProseMirror)
5. Editor swap on type-changing rename: dispose current editor, create new one
6. Transition state UI: loading indicator between rename detection and migration arrival

**This phase is UI-only.** All data-layer logic is complete by Phase 4.

---

## Integration Demo: Browser + Filesystem Sync

### Architecture

End-to-end demo that proves the isomorphic claim: a Svelte app views/edits files in the browser, a Node process syncs the same Yjs state to real files on disk, both connected through y-websocket.

```
┌─────────────────────┐     y-websocket      ┌────────────────────────┐
│   Browser (Svelte)  │◄───────server────────►│  Node Process (bun)    │
│                     │    (localhost:PORT)    │                        │
│  Main Y.Doc         │                       │  Main Y.Doc            │
│   └─ files table    │                       │   └─ files table       │
│                     │                       │                        │
│  Content Y.Docs     │                       │  Content Y.Docs        │
│   └─ on-demand      │                       │   └─ all loaded        │
│                     │                       │                        │
│  File tree UI       │                       │  Chokidar watcher      │
│  Code editor        │                       │  Real filesystem sync  │
│  Markdown editor    │                       │  Bidirectional:        │
│                     │                       │   YDoc → disk writes   │
│                     │                       │   disk → YDoc updates  │
└─────────────────────┘                       └────────────────────────┘
```

### Components

**1. y-websocket server** (process 1):
```bash
HOST=localhost PORT=0 npx y-websocket  # random open port
```
One WebSocket connection per Y.Doc. Main doc always connected. Content docs connected on demand.

**2. Node sync process** (`epicenter-sync.ts`, process 2):
```typescript
import { createWorkspace, defineTable, defineWorkspace } from '@epicenter/static';
import { WebsocketProvider } from 'y-websocket';
import * as chokidar from 'chokidar';

// Create workspace with files table
const workspace = createWorkspace(filesystemDefinition);
const filesTable = workspace.tables.files;
const index = createFileSystemIndex(filesTable);
const pool = createContentDocPool((ydoc) => {
  // Connect each content doc to y-websocket
  return new WebsocketProvider(`ws://localhost:${PORT}`, ydoc.guid, ydoc);
});

// Connect main doc to y-websocket
const mainProvider = new WebsocketProvider(`ws://localhost:${PORT}`, 'filesystem-main', workspace.ydoc);

// Ingest real directory → Yjs filesystem
await ingestDirectory('/path/to/target/folder', filesTable, pool);

// Bidirectional sync (adapted from markdown provider patterns)
const syncCoordination = { yjsWriteCount: 0, diskChangeCount: 0 };

// YDoc → disk: observe content doc changes, write to real files
filesTable.observe((changedIds) => {
  if (syncCoordination.diskChangeCount > 0) return;
  syncCoordination.yjsWriteCount++;
  // ... write changed files to disk
  syncCoordination.yjsWriteCount--;
});

// Disk → YDoc: chokidar watches real files, updates content docs
const watcher = chokidar.watch(targetDir, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
});
watcher.on('change', async (filePath) => {
  if (syncCoordination.yjsWriteCount > 0) return;
  syncCoordination.diskChangeCount++;
  // ... read file, update Yjs content doc
  syncCoordination.diskChangeCount--;
});
```

**3. Browser app** (Svelte, process 3):
- Connects to same y-websocket server
- File tree component reads from `files` table via `readdir()`/`readdirWithFileTypes()`
- Click file → `pool.acquire(fileId)` → bind editor to content Y.Doc
- CodeMirror for code files, Milkdown for `.md` files
- Edits propagate through Yjs → y-websocket → Node process → real filesystem

### Ingestion

```typescript
async function ingestDirectory(
  realPath: string,
  filesTable: TableHelper<FileRow>,
  pool: ContentDocPool,
  parentId: string | null = null,
): Promise<void> {
  const entries = await fs.readdir(realPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(realPath, entry.name);
    const id = generateGuid();

    if (entry.isDirectory()) {
      filesTable.set({
        id, name: entry.name, parentId, type: 'folder',
        size: 0, createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
      });
      await ingestDirectory(fullPath, filesTable, pool, id);
    } else {
      const content = await fs.readFile(fullPath, 'utf-8');
      filesTable.set({
        id, name: entry.name, parentId, type: 'file',
        size: Buffer.byteLength(content), createdAt: Date.now(), updatedAt: Date.now(), trashedAt: null,
      });
      // Write content to Yjs content doc
      const handle = pool.acquire(id, entry.name);
      if (handle.type === 'text') {
        handle.content.insert(0, content);
      } else {
        const { frontmatter, body } = parseFrontmatter(content);
        updateYMapFromRecord(handle.frontmatter, frontmatter);
        updateYXmlFragmentFromString(handle.content, body);
      }
      pool.release(id);
    }
  }
}
```

### Why this demo

- **Proves isomorphic claim**: Same `YjsFileSystem` class works in browser (via just-bash) and in Node (direct table/index access)
- **Proves real-world sync**: Edit in browser → appears on disk. Edit on disk → appears in browser.
- **Proves lazy loading**: Browser only loads content docs for open files. Node process loads all (server has memory).
- **Proves provider model**: y-websocket relays both main doc and content docs between peers.
- **Exercises the full stack**: files table, runtime indexes, content doc pool, IFileSystem, just-bash integration, serialization pipeline.
- **Uses existing patterns**: Sync coordination (counter-based, from markdown provider), chokidar (from markdown provider), y-websocket (already installed).

---

## Open Questions

1. **Markdown source view**: Convert-on-switch is the strategy for file type changes (rename). Remaining question: should the editor offer a source-view toggle within a `.md` file (show raw markdown in CodeMirror alongside or instead of the rich editor)?
2. **Binary files**: Store blob references in files table metadata? Separate blob storage system?
3. **File size limits**: Large files (>1MB) as Y.Text are expensive. Read-only mode above a threshold?
4. **Plaintext cache warming**: Should the server eagerly cache all content for fast first-grep? Or always lazy?
5. **Front matter deep merge**: Y.Map stores top-level YAML keys with LWW semantics. Nested objects (e.g., `metadata: { author: "...", version: "..." }`) are stored as opaque JSON — concurrent edits to different nested keys within the same top-level key will be LWW (one wins). Is this sufficient, or should deeply nested front matter use nested Y.Maps? Recommendation: start with flat LWW. Deep merge adds complexity and front matter is rarely deeply nested in practice.
