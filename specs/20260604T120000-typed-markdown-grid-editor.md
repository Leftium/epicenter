# Matter (typed markdown folder editor)

**Date**: 2026-06-04
**Status**: Draft (grilled: self + Codex; co-designed to model-first: data / model / layout)
**Owner**: Braden
**Confines**: `20260602T200000-vault-read-only-projection-agent-mutation.md` (read-only projection applies only inside declared regions; mechanism deferred)
**Reuses**: closed PR #1897 `wiki-page-body-write-actions` (lens + `buildColumnSchema`), `packages/workspace` `column.*` + the `column.* -> SQLite` materializer

## One Sentence

Open a folder of markdown, give it a model, and see every file sorted into valid, invalid, and unparseable against that model, fixing any cell in place, in a table (later board and calendar) view, where for your drafts "valid" means "ready to publish."

## How to read this spec

```
Read first:
  One Sentence
  The three layers (data / model / layout)
  Conformance (valid / invalid / extra / unparseable)
  The KINDS registry
  Implementation Plan

Read if changing the architecture:
  Design Decisions
  Materialized SQLite
  Round-trip identity (never mangle)
  Edge Cases

Deferred (designed, not built in v1):
  board / calendar / gallery views, the TS DSL, read-only regions, wiki absorption
```

## The three layers

The product is model-first. Inference exists only as an on-ramp to a model, never as the foundation.

```
markdown files = data        the truth. never mangled.
matter.json    = model       the contract: typed fields + conformance policy. NEVER gates a write.
               + layout       views: order / width / hidden / sort / filter. references the model's fields.
```

`matter.json` is one folder-local file with both concerns kept as separate keys:

```jsonc
// folder/matter.json   — app-, agent-, and raw-editable. JSON is canonical (no eval).
{
  "strict": false,
  "fields": {                                            // the CONTRACT (each value is a column.* serialized)
    "title":    { "kind": "string", "required": true },
    "status":   { "kind": "enum", "values": ["draft","published","archived"], "required": true },
    "duration": { "kind": "number" },
    "url":      { "kind": "url" }
  },
  "views": [                                             // LAYOUT only; optional (absent = one default table view)
    { "name": "Editorial", "type": "table",
      "columns": ["title","status","duration"], "hidden": ["url"], "sort": [{ "id": "status" }] }
  ]
}
```

### Why JSON is canonical (and where it stops)

The app's UI edits the model, agents edit it, you edit it raw. JSON round-trips through all three with **no eval step**; a `.ts` file needs a bundler or the bun daemon and cannot be safely UI-rewritten.

```
JSON handles the DECLARATIVE parts            JSON stops at LOGIC (-> optional TS DSL, later)
  kinds, required, enum values, views           computed fields (wordCount from body)
  app + agent + UI all edit it                  custom validators, derived columns
```

The optional `defineMarkdownModel({ fields: { title: column.string() } })` DSL is authoring sugar that compiles to this JSON and is the only place logic could ever live. Not needed for v1. Caveats: the model is app-owned and comment-free (the app rewrites it); a hand-authored `.ts` and UI-editing cannot both own the same model.

### Each field IS a `column.*`, serialized

```
TS DSL (later)            JSON (canonical)               registry
title: column.string()    "title":{"kind":"string"}      KINDS.string.build === column.string
status: column.enum([…])   "status":{"kind":"enum",…}      buildColumnSchema(...) === column.enum([…])
```

`buildColumnSchema({ kind: "string" })` returns exactly what `column.string()` returns. The JSON `kind` is the serializable name of the `column.*` helper; the `KINDS` registry is the lookup. (Field name = the frontmatter key; no separate id; optional `label` overrides display.)

## Conformance (the core job)

The app's job, stated once: **show me how this folder conforms to its model, and let me fix what doesn't.** Each file is classified against the model:

```
VALID         every PRESENT modeled value fits its kind; every REQUIRED field is present
              -> the main grid. projects cleanly into SQLite.   == getValid() == SELECT * FROM <folder>
INVALID       a required field is missing, OR a present modeled value fails its kind
              -> a "Needs attention" section. kept verbatim, EDITABLE IN PLACE, never deleted/rejected.
UNPARSEABLE   conflict markers / broken YAML
              -> a "Can't read" section. the grid NEVER writes it; opens raw.

EXTRA (orthogonal)   frontmatter keys not in the model. a VALID or INVALID row may have them.
              -> a per-row "•••" expander + a folder-level "unmodeled keys" nudge ("add to the model?").
              -> default allowed. `"strict": true` demotes extras to INVALID (strict content pipelines).
```

Three rules keep this honest:

```
1. the model NEVER gates a write.  you can always save a draft missing its title; it just shows as INVALID.
2. validity is a property of (data x model), NOT of the data.  change the model and rows reclassify;
   files never change.  prefer the label "Needs attention" over "Invalid".
3. required is opt-in PER FIELD.  missing an optional field is fine (empty cell); missing a REQUIRED field is invalid.
```

It must stay an EDITOR, not a linter: clicking an invalid cell fixes it in place. A read-only conformance report is something you run; this is something you live in.

## The KINDS registry (the column.* bridge)

One registry pairs each kind's `column.*` builder with its cell and editor. `ColumnKind = keyof typeof KINDS`, so the mapping to `column.*` is 1-1 by construction.

```ts
const KINDS = {
  string:   { build: column.string,   cell: StringCell, editor: StringEditor },
  integer:  { build: column.integer,  cell: NumberCell, editor: IntEditor },
  number:   { build: column.number,   cell: NumberCell, editor: NumberEditor },
  boolean:  { build: column.boolean,  cell: BoolCell,   editor: BoolEditor },
  datetime: { build: column.dateTime, cell: DateCell,   editor: DateEditor },
  url:      { build: column.url,       cell: UrlCell,    editor: UrlEditor },
  enum:     { build: column.enum,      cell: EnumCell,   editor: EnumEditor },
} satisfies Record<string, KindEntry>;
type ColumnKind = keyof typeof KINDS;
```

**Inference is NOT a separate predicate column.** A value's kind is the narrowest kind in the lattice whose `build` schema accepts it, `Value.Check(KINDS[k].build(), v)`. There is one definition of "what is a `datetime`" (the schema), used for both the inferred preview and conformance, so the two cannot drift. An earlier draft paired a hand-written `infer` predicate with each `build`; that is two sources of truth, and a `datetime` predicate looser than `column.dateTime` would make the inferred model invalidate its own rows. It was dropped.

```
infer(v)  = first k in lattice where Value.Check(KINDS[k].build(), v)     ── never a parallel predicate
classify  = Value.Check(KINDS[field.kind].build(), v)                     ── same call, same answer
```

Two consequences this design owes (honored when the schemas are lifted in increment 2):

```
register the 'uri' format first, or column.url's validator is a no-op that accepts EVERY string
  (so every string would infer 'url'). Until then, inference's url predicate stays stricter (http/https only).
enum and string stay OUT of the lattice: string is the floor that always matches; enum is opt-in, never inferred
  (a string set infers as 'string'; you opt in, and it harvests the column's distinct values).
```

Increment 1 ships a conservative regex stand-in (`isIsoDateTime`, `isUrl`) instead of `Value.Check`, because the pure core has no workspace dependency yet. It obeys the same invariant below: under-claim to `string`, never over-claim a kind the schema would reject.

`nullable` / `array` are composable modifiers (flags on a field), not kinds; `json` is the read-only fallback cell for a non-scalar value. Adding a type = one registry entry + one `column.*` helper.

## Inference is the on-ramp, not the foundation

No `matter.json` in a folder:

```
show an inferred PREVIEW table (YAML types + light string refinement: date? url?)
banner: "No model for this folder"
action: "Create model from folder"  -> writes matter.json from the discovered frontmatter
```

This keeps the zero-config first impression without making inference the source of truth. Inference is thin (the YAML parser already gives number/boolean/string/list; refinement only touches strings) and deterministic (same files -> same preview).

### The on-ramp invariant (may under-claim, never over-claim)

```
inferValueKind(v) = k   ⟹   Value.Check(buildColumnSchema(k), v)
```

Inference is allowed to fall to `string`; it is never allowed to suggest a kind whose schema would reject the value. The trap this rules out is concrete: a bare `date: 2026-06-04`, the most common frontmatter shape, is **not** a `datetime`. `column.dateTime` is full RFC 3339 and rejects the bare date. If inference claimed `datetime`, "Create model from folder" would write a model that instantly marks every one of those rows invalid: the on-ramp invalidating its own folder. So a bare date, and any looser timestamp (space separator, missing offset, no seconds), infers as `string`. Only a full instant (`2026-06-04T10:30:00Z`) infers `datetime`.

A dedicated `date` kind is deferred, not refused. It arrives as a full vertical slice (`column.date` in the shared library + cell + editor + classify) alongside the calendar view, rather than as a half-member that only inference can produce.

## Materialized SQLite (the query surface and the definition of valid)

Each view materializes a SQLite table you can query with raw SQL. It also gives `valid` its precise meaning: a row is valid iff it projects into the typed table. 1:1:1:

```
model field   ⟷   grid column   ⟷   SQLite column
     kind ─ column.* ─ derive.ts / materializer/sqlite/ddl.ts ─▶ SQLite type + CHECK   (EXISTING, reuse)
table per folder:  { path PK, ...typed columns..., _extra JSON of unmodeled keys }
```

Reuse the `column.* -> SQLite` derivation (`packages/workspace/src/document/{column/derive.ts, materializer/sqlite/ddl.ts}`); write a thin file-driven projector, skipping the Yjs log/room writer. **Derived + disposable** (delete -> rebuild from files), **read-only** (SELECT; mutations go through editors -> markdown). `getValid()` is `SELECT * FROM <folder>`. SQL write-back is a separate hard problem, deferred.

## Round-trip identity (never mangle)

> Read a file, write it back with no user edit -> value-identical. The editor changes only the exact field the user changed; everything it does not understand or did not touch is preserved.

```
unknown / unmodeled key      preserved on write (never dropped)
nested / non-scalar value    json fallback render, never flattened
required-missing / mismatch   INVALID classification, kept verbatim
YAML coercion (Norway prob.)  use a YAML 1.2 parser; round-trip test is the backstop
body vs frontmatter          strict separation; editing one never touches the other
unparseable file             the grid NEVER writes it
```

## Architecture (v1)

A plain Tauri + SvelteKit app. **Not** a workspace app: no `createWorkspace`, no Yjs, no relay, no auth, no session.

```
Tauri fs ─ walk vault ─ sidebar tree ─ open a folder
   ─ read matter.json (or infer a preview)
   ─ read .md INTO MEMORY: Row = { path, frontmatter, body }
   ─ classify each row against the model ─ compileColumns ─ table grouped by conformance
   ─ edit cell / body ─ validated write fn ─ frontmatter write-back (preserve unmodeled keys) ─ file
```

### Routes (SvelteKit)

```
/                       vault home: folder tree + recents
/[...folder]            a folder -> conformance grid (table view; ?view= later)
/[...folder]/[file]     a file -> document view (property panel + body textarea); peek over the grid
```

## Why build this and not use Obsidian Bases (honest)

Bases renders database-views over discovered frontmatter, non-enforcing. The typed-table feature is not the differentiator. Matter is worth building only because it is: (1) open and ownable, code-extensible `KINDS` registry, agent-editable JSON, vs a closed plugin; (2) a **conformance / publish-readiness** view (validate a folder against a contract, group by ready/broken) that Bases does not do; (3) the authoring front-end of the capture-to-post pipeline; (4) on a path to real-time collaboration file-level sync cannot reach. If it decouples from shipping content, it is a worse, unfinished Bases.

## Design Decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Source of truth | 2 | markdown files; the model never enforces a write | data is truth; only side where conformance can be non-destructive |
| Model first | 2 | explicit `matter.json`; inference is the on-ramp | explicit > magic for a durable tool; gives the app a pass/fail job |
| File shape | 3 | one file, `{ strict, fields, views }` | fewer artifacts; separation is two keys, not two files |
| Model format | 2 | JSON canonical; TS DSL optional/later | only format the UI + agents can both read and write without eval |
| Field = column.* | 2 | `kind` + flags, compiled by `buildColumnSchema` | the JSON is `column.*` serialized; `KINDS` is the lookup |
| Conformance | 2 | valid / invalid / unparseable + orthogonal extras | precise (projectable or not); `strict` toggles extras-as-invalid |
| `required` | 2 | per-field, classification only, never a write gate | author declares intent; makes "missing" meaningful without enforcing |
| Materialized SQLite | 2 | per-view, read-only raw SQL (increment 4) | a capability (raw SQL) + defines validity; reuses the existing materializer |
| App shape | 2 | new lean Tauri app `apps/matter`, not folded into Fuji | two truth models in one app branch its core forever; share only leaf UI |
| Body editor v1 | 3 | textarea + whole-body save | proves the round-trip; CodeMirror/WYSIWYG later |
| Read-only regions / wiki absorption | Deferred | Deferred | no materialized region yet; introduce a storage seam from two real backends |

## Implementation Plan

### Increment 1: read (open folder -> table)

- [ ] **1.1** Scaffold `apps/matter` as a plain Tauri + SvelteKit app (no workspace machinery); Tauri fs module
- [ ] **1.2** Vault tree, open a folder; parse `.md` -> `Row = { path, frontmatter, body }`; graceful unparseable state
- [ ] **1.3** The `KINDS` registry (read cells + `infer`); infer a preview table; deterministic order

### Increment 2: model + conformance

- [ ] **2.1** Read `matter.json`; compile `fields` via `buildColumnSchema`; lift the lens. Replace the increment-1 inference regexes with `Value.Check(KINDS[k].build(), v)` so infer and classify share one definition; register the `uri` format first (else `column.url` accepts every string)
- [ ] **2.2** Classify rows: valid / invalid / unparseable; orthogonal extras (expander + `strict`)
- [ ] **2.3** "No model" banner + "Create model from folder" (writes `matter.json` from discovered frontmatter)

### Increment 3: edit (fix in place)

- [ ] **3.1** Inline cell editors per kind; frontmatter write-back preserving unmodeled keys (fidelity per Open Q1)
- [ ] **3.2** Fix an invalid cell -> the row reclassifies live; document/peek view + body textarea
- [ ] **3.3** Model editing UI: add/retype a field; `enum` harvests distinct values

### Increment 4: SQLite + raw SQL

- [ ] **4.1** File-driven SQLite projector reusing `column/derive.ts` + `materializer/sqlite/ddl.ts`; one table per view
- [ ] **4.2** Raw `SELECT` surface; `getValid()` == `SELECT * FROM <folder>`; rebuild-from-files yields the same table

### Later (designed, not scheduled)

- [ ] views: board (group-by status = a publishing pipeline), calendar (group-by date = a content calendar), gallery
- [ ] a first-class `date` kind (bare calendar date): `column.date` + cell + editor + classify, landing with the calendar view; until then bare dates infer as `string`
- [ ] the TS DSL (`defineMarkdownModel`) + computed/derived fields; cross-folder SQL; SQL write-back
- [ ] read-only-region enforcement; Fuji adopts the `KINDS` registry; storage seam + wiki absorption

## Edge Cases

### Draft missing its required title
Classified INVALID (not ready), but the save still succeeds and the file is untouched. The model never blocks a write.

### A value stops matching after a model change
`duration` retyped to `number` while a row holds `"1240s"` -> reclassifies to INVALID, kept verbatim, editor offers a typed replacement. The file did not change; the model did.

### YAML type coercion (the real looseness risk)
Inference and parsing lean on the YAML parser; YAML 1.1 coerces (`NO` -> false, `1.10` -> 1.1). Use a YAML 1.2 parser; round-trip identity (read-write-unchanged = value-identical) is the backstop. This, not markdown prose (the body is opaque text we never AST-parse), is where "markdown is too loose" applies to us.

### `matter.json` is junk / names an unknown kind
Falls back to the inferred preview with a non-blocking banner; unknown kinds rejected by the closed `ColumnKind` set. Deleting `matter.json` always recovers a working preview; data untouched.

## Open Questions

1. **Frontmatter write-back fidelity** (sizes increment 3 + the round-trip invariant): byte-identical (preserve comments/order/quotes) or value-identical (canonical re-serialize)?
   - **Recommendation**: value-identical (canonical) for v1; never loses data, far less work. Revisit if hand-formatted YAML matters.

2. **Dogfood target** (grounds increment 1): point Matter at the capture-to-post drafts folder, so the first model is the post contract and `valid` = the publish queue.
   - **Recommendation**: yes; this is the weld that justifies the app.

## Success Criteria

- [ ] **Inc 1**: open a folder; it renders as a table with kinds inferred (deterministic order); unparseable files degrade gracefully
- [ ] **Inc 2**: `matter.json` validates files into valid / invalid / unparseable; "Create model from folder" writes a usable model
- [ ] **Inc 3**: editing an invalid cell reclassifies the row live; round-trip identity holds (no-op edit = value-identical file; unmodeled keys survive)
- [ ] **Inc 4**: each view materializes a SQLite table; raw `SELECT` returns valid rows; rebuild-from-files is identical
- [ ] Every `KINDS` entry maps 1-1 to a `column.*` helper; `valid` means a row projects into the typed table

## References

- `apps/fuji/src/routes/(signed-in)/components/EntriesTable.svelte` - the TanStack Table + `@epicenter/ui` pattern to mirror
- `packages/workspace/src/document/column/sugar.ts` - the `column.*` builders the `KINDS` registry references
- `packages/workspace/src/document/{column/derive.ts, materializer/sqlite/ddl.ts}` - the `column.* -> SQLite` derivation to reuse
- closed PR #1897 `apps/wiki/src/lib/workspace/{lens,schema}.ts` - the lens + `buildColumnSchema` switch to lift
- `packages/ui/src/{table,tree-view,popover,select,natural-language-date-input}` - components for the grid and editors
- `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` - the read-only-projection contract this confines
