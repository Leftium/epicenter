# Epicenter Todos First Slice

## Intent

Build `apps/todos` as a local-first SvelteKit app backed by Epicenter workspace tables. The first slice proves the durable model, frontmatter shape, and a small usable surface. It does not schedule notifications, add sync auth, or create a project/tag taxonomy.

## Model

`todos`

- `id`: generated todo id.
- `title`: required editable label.
- `body`: required string, empty when the todo has no notes.
- `dueDate`: nullable ISO calendar date (all-day; no time or timezone in this slice).
- `contexts`: ordered array of `ContextSlug` values.
- `completedAt`: nullable UTC instant.
- `deletedAt`: nullable UTC instant.
- `createdAt`: UTC instant.

`contexts`

- `id`: `ContextSlug`, the stable file-facing id.
- `name`: editable display label.
- `color`: display color token, auto-assigned from a fixed palette by creation order so every context is visually distinct without a picker.
- `sortOrder`: numeric ordering slot.

## Invariants

A todo's due date is `none` (`dueDate` is null) or `all-day` (`dueDate` is a calendar date). Timed and timezone-aware due dates are out of this slice; because due is a single self-validating field there is no cross-field parsing layer.

Contexts use stable slugs as row ids because the slug is the durable file-facing and URL-facing identifier. There are two distinct renames:

- Rename the **label** (`name`): free, edits the context row only, never touches todos. This is the common case (typo fix, relabel) and is always available.
- Rename the **slug** (`id`): the rare, deliberate O(todos) migration. It rewrites matching todo context arrays in one transaction.

Deleting a context cascades: the slug is removed from every todo in one transaction. A todo that still carries a slug with no matching context row (hand-edited file, mid-sync) stays legal and renders as a neutral chip. Neutral rendering is a resilience fallback, not a managed workflow: in-app, contexts are added by picking a known one and removed/renamed via the explicit actions above, so orphans should not arise in normal use.

### Context identity decision

The slug is a human-readable natural key, deliberately chosen over the two alternatives:

- **Bare strings** (no contexts table): rejected because the vision needs per-context color and ordering, which need a row to hang on.
- **Opaque stable id + slug** (nanoid `ctx_...` as the reference): rejected for the first slice. In a markdown-first app, whatever the todo embeds is what lands in the file; embedding an opaque id makes files non-self-describing and forces bespoke join-on-export, slug-uniqueness conflict handling across CRDT merges, and import resolution. That machinery only buys cheap *slug* renames, which are rare. The natural-key model already gives free *label* renames with none of it. A stable id can be layered in later if frequent slug renames or slug-surviving cross-references become a concrete need.

## First Slice

1. Add `apps/todos` with the same app-root workspace contract pattern used by the other apps: an isomorphic model file, a browser opener, SvelteKit app shell, and package exports.
2. Implement branded ids and validators for `TodoId` and `ContextSlug`.
3. Implement the context actions: create with generated slug and auto-color (`contexts_create`), label/color edit (`contexts_update`), slug rename migration (`contexts_rename_slug`), and cascade delete (`contexts_delete`). The rename/delete migrations are internal helpers (no external consumer earns an export).
4. Add focused unit tests for slug validation, due-date round-trip, auto-color, label rename, slug rename, and cascade delete.
5. Add a UI using `packages/ui` that can create todos (with an all-day due date), complete and reopen, soft-delete, create/rename/delete contexts, and view todos by context. Use native primitives (`Empty`, `Popover`, `NaturalLanguageDateInput`, `confirmationDialog`).

## Non-goals

- No notification scheduler.
- No auth or cloud sync.
- No project, area, or tag taxonomy.
- No `updatedAt` until a concrete feature earns it.
- No timed/timezone-aware due dates until a feature earns them.

## Deferred

- Frontmatter serialization/parsing and a markdown materializer. The model is ready for it, but no materializer is wired (`todos.browser.ts` uses IndexedDB plus BroadcastChannel only), so serialize/parse helpers would be dead code today. Add them together with the materializer. When they land, frontmatter must quote context slugs, including slugs with no current context row.
- A stable opaque id alongside the slug, if frequent slug renames or slug-surviving cross-references become a concrete need.

## Verification

- `bun test apps/todos/todos.test.ts`
- `bun --filter @epicenter/todos typecheck`
