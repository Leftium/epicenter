# Honeycrisp

A local-first notes app styled after Apple Notes. Folders, a note list, and a collaborative rich-text editor—all backed by an Epicenter workspace with Yjs CRDTs, persisted to IndexedDB, and synced over WebSocket.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

### Layout

Single-route SvelteKit app (`+page.svelte`) with a three-pane layout: sidebar (folders) → note list → editor. SSR is disabled; the app runs entirely in the browser as a static site.

### Data layer

All state lives in an Epicenter workspace (`id: "epicenter.honeycrisp"`). The workspace is created once on startup, wired to IndexedDB for local persistence, and connected to a WebSocket server for real-time sync. Auth tokens and encryption keys are applied at login before any data is read or written.

### Rich-text editing

Each note's body is a `Y.XmlFragment` stored as an attached document on the `notes` table. ProseMirror binds to it via `y-prosemirror`, giving collaborative editing for free. The editor schema covers paragraphs, headings, lists, task lists, underline, and strikethrough. Every ProseMirror transaction extracts a title, preview snippet, and word count, which are written back to the note's table row.

### Auth

Google sign-in via `@epicenter/svelte/auth-form`. The session is persisted across reloads. Encryption keys are applied on login before the workspace connects.

---

## Workspace schema

**Workspace ID:** `epicenter.honeycrisp`

### Tables

**`folders`**
| Field | Type |
|---|---|
| `id` | `FolderId` |
| `name` | `string` |
| `icon` | `string` (optional) |
| `sortOrder` | `number` |
| `_v` | version |

**`notes`** (v2, migrated from v1)
| Field | Type |
|---|---|
| `id` | `NoteId` |
| `folderId` | `FolderId` (optional) |
| `title` | `string` |
| `preview` | `string` |
| `pinned` | `boolean` |
| `createdAt` | `number` |
| `updatedAt` | `number` |
| `deletedAt` | `number` (optional, soft delete) |
| `wordCount` | `number` (optional) |

Each note has an attached document: `withDocument('body', { guid: 'id', onUpdate })` → `Y.XmlFragment`.

The v1→v2 migration adds `deletedAt` and `wordCount`.

### KV

| Key | Type |
|---|---|
| `selectedFolderId` | `FolderId` |
| `selectedNoteId` | `NoteId` |
| `sortBy` | `'dateEdited' \| 'dateCreated' \| 'title'` |

---

## Features

- **Soft delete** — notes get a `deletedAt` timestamp and appear in "Recently Deleted". Restore or permanently delete from there.
- **Pin/unpin** — pinned notes sort to the top of the list.
- **Folder deletion** — re-parents all notes in the folder to unfiled and clears the KV selection, keeping the data intact.
- **Sorting** — note list sorts by date edited, date created, or title.
- **Search** — filters the note list by title and preview content.
- **Keyboard shortcuts** — `Cmd+N` creates a new note, `Cmd+Shift+N` creates a new folder.
- **Context menus** — per-note actions: pin, move to folder, delete, restore.

---

## Development

```bash
# Start dev server (local API)
bun run dev:local

# Start dev server (production API)
bun run dev:remote

# Production build
bun run build

# Type checking
bun run typecheck
```

The dev server runs on port **5175**.

---

## License

MIT
