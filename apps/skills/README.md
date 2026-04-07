# Skills Editor

Browser-based editor for creating and managing Epicenter agent skills. Backed by Yjs CRDTs for collaborative editing, with full offline support via IndexedDB.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. MIT licensed.

---

## How it works

**Workspace connection.** The app imports `createSkillsWorkspace` from `@epicenter/skills`, which provides two tables: `skills` (metadata + attached instructions document) and `references` (per-skill reference files, each with its own content document). The workspace ID is `epicenter.skills`.

**Collaborative editing.** Each skill's instructions and each reference's content are `Y.Doc`-backed documents. CodeMirror 6 with `y-codemirror.next` binds directly to those documents, so edits are conflict-free and survive concurrent sessions.

**Local-first only.** Persistence is IndexedDB. No remote sync provider is wired in this app—it's a standalone local editor.

**UI shell.** A single route renders an `AppShell` with a resizable split view: a sidebar on the left and an editor panel on the right.

- **Sidebar** — skill list with search, keyboard navigation (arrow keys), inline rename (F2), and delete with confirmation.
- **Editor panel** — `SkillMetadataForm` (name, description, license, compatibility), `InstructionsEditor` (CodeMirror + Yjs), and `ReferencesPanel` (expandable list of reference files, each with its own CodeMirror editor).
- **Command palette** — search across skills from anywhere.
- **NewSkillDialog** — creates a new skill and focuses it immediately.

## Workspace schema

Workspace ID: `epicenter.skills`

| Table | Columns | Attached doc |
|---|---|---|
| `skills` | `id`, `name`, `description`, `license`, `compatibility` | `instructions` (Y.Doc) |
| `references` | `id`, `skillId`, `name` | `content` (Y.Doc) |

## Stack

- SvelteKit (SSR disabled), Svelte 5 runes
- Tailwind CSS
- CodeMirror 6 + `y-codemirror.next`
- `@epicenter/skills`, `@epicenter/workspace`, `@epicenter/svelte`, `@epicenter/ui`

## Development

```sh
bun run dev:local    # local dev server (bun --bun vite dev)
bun run dev:remote   # dev server against production mode
bun run build        # production build
bun run check        # svelte-kit sync && svelte-check
```

## License

MIT
