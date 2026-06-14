# Epicenter Todos First Slice

## Intent

Build `apps/todos` as a local-first SvelteKit app backed by Epicenter workspace tables. The first slice proves the durable model, frontmatter shape, and a small usable surface. It does not schedule notifications, add sync auth, or create a project/tag taxonomy.

## Model

`todos`

- `id`: generated todo id.
- `title`: required editable label.
- `body`: required string, empty when the todo has no notes.
- `dueDate`: nullable ISO calendar date.
- `dueTime`: nullable `HH:mm` local wall time.
- `dueZone`: nullable IANA timezone.
- `contexts`: ordered array of `ContextSlug` values.
- `completedAt`: nullable UTC instant.
- `deletedAt`: nullable UTC instant.
- `createdAt`: UTC instant.

`contexts`

- `id`: `ContextSlug`, the stable file-facing id.
- `name`: editable display label.
- `icon`: nullable display icon.
- `color`: nullable display color token.
- `sortOrder`: numeric ordering slot.

## Invariants

Due state is one of exactly three shapes:

- `none`: `dueDate`, `dueTime`, and `dueZone` are null.
- `all-day`: `dueDate` exists, `dueTime` is null, and `dueZone` is null.
- `timed`: `dueDate`, `dueTime`, and `dueZone` all exist.

`dueZone` exists iff `dueTime` exists. `dueTime` implies `dueDate`.

Contexts use stable slugs as row ids because the slug is the durable file-facing identifier. Context names are normal editable labels. Slug rename is a deliberate migration action that rewrites matching todo context arrays in one transaction. Unknown but syntactically valid context slugs remain legal on todos and render as neutral chips.

Frontmatter always quotes context slugs, including slugs that are not currently known context rows.

## First Slice

1. Add `apps/todos` with the same app-root workspace contract pattern used by the other apps: an isomorphic model file, a browser opener, SvelteKit app shell, and package exports.
2. Implement branded ids and validators for `TodoId`, `ContextSlug`, and `TodoTimeString`.
3. Implement due parsing and normalization helpers.
4. Implement frontmatter serialization and parsing helpers for todo markdown.
5. Implement context slug rename as an explicit workspace action and exported helper.
6. Add focused unit tests for slug validation, due parsing, slug rename, and frontmatter round-trip.
7. Add a small UI using `packages/ui` that can create, complete, soft-delete, and view todos by context.

## Non-goals

- No notification scheduler.
- No auth or cloud sync.
- No project, area, or tag taxonomy.
- No `updatedAt` until a concrete feature earns it.

## Verification

- `bun test apps/todos/todos.test.ts`
- `bun --filter @epicenter/todos typecheck`
