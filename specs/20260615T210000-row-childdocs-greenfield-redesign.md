# Row child-docs: greenfield clean-break redesign pass

**Date:** 2026-06-15
**Status:** Implemented
**Scope:** `feat/trusted-relay-row-childdocs` (423a05426..HEAD)
**Stance:** Greenfield. Child docs were added on this unshipped branch, so the
runtime child-doc accessor has no external consumer and no durable contract yet.
The guid *string* and sync wire are unchanged by every decision below.

---

## Wave 2 (PRIMARY) — table child-doc API shape

**Product sentence:** A table row owns one collaborative child document per
declared field; the caller opens it by row id through a single namespaced path
on the table handle.

**Drift:** Child-doc openers are spread flat onto the table handle beside
`get`/`set`/`scan`/… So a child doc named `set` collides with `table.set`. To
prevent that, the branch carries a `RESERVED_TABLE_CHILD_DOC_NAMES` runtime
`Set`, a duplicate `ReservedTableChildDocName` type union, a `SafeChildDocLayouts`
conditional type, a runtime `throw`, and two tests — a *dual source of truth*
(every new table method must be hand-added to both the Set and the union or the
guard silently lets a collision through). That is a guard hiding a namespace
design problem, not a victory.

**Value owners:** guid derivation → `connectTableChildDocs` (workspace.ts, has
workspaceId + table key + field + connection in scope). Child-doc lifecycle →
`createChildDocs` guid-keyed `createDisposableCache`. Reserved-name invariant →
nobody clean; it is checked too late, at connect time, and duplicated.

**Code family created:** `RESERVED_TABLE_CHILD_DOC_NAMES`, `ReservedTableChildDocName`,
`SafeChildDocLayouts`, the connect-time throw, the throw test, the `@ts-expect-error`
test, ongoing dual-list maintenance.

**Greenfield clean break:** Put child docs under their own `.docs` sub-namespace
on the table handle: `workspace.tables.notes.docs.body.open(rowId)`. Field names
now live one level below the CRUD methods, so they are *structurally* incapable
of colliding — for ANY field name, including `set`, `guid`, `open`. The entire
reserved-name family is deleted. `.childDocs({...})` stays as the declaration
builder (clearest at definition time, already taught everywhere); `.docs` is the
runtime namespace.

**History check (not a re-litigation):** The Feb `.docs` design
(`20260217T094400`) was abandoned because the heavy `DocumentBinding` (8 methods,
async `open` returning a `Y.Doc`, `getExports`) was redesigned, not because the
namespace was wrong. The reverted `bb9c8e6ef` removed a *peer* registry
(`bound.<table>.<field>`) — a second table registry, a real ownership smell. This
proposal is neither: it is a sub-namespace on the existing, audited on-table
accessor. It keeps the audited "child docs live on the table handle" property and
removes the collision the flat spread introduced.

**User loss:** One extra path segment (`.docs.`) at every call site. No behavior
change, no guid change.

**Decision:** **redesign** → `.docs` sub-namespace; delete the entire reserved-name
guard family.

---

## Wave 1 — workspace opener shape

**Decision:** **keep** the three `open()` overloads. They are three genuinely
different return types (inert root for daemons / connected browser / connected +
runtime extras), and `open()` (zero-arg) has real daemon callers
(`fujiWorkspace.open()` in every `project.ts`). The naming `open` for both the
inert root and the connecting form is a mild verb overload but not worth a
breaking split for the small win.

---

## Wave 4 — action registry ownership

**Drift:** `compose` returns `{ actions?, [Symbol.dispose]?, ...extras }`. The
`actions?` is optional with a `?? base` fallback (`RuntimeActions` conditional).
Collaboration is wired AFTER compose with the final registry — that ordering is
the load-bearing reason the compose overload exists, and it is correct.

**Decision:** **redesign (small)** — make `actions` REQUIRED in the compose
return; delete the `?? actions` fallback and the `RuntimeActions` conditional.
The only compose consumer (OpenSidian) already always returns `actions`. Document
the contract: "the `actions` you return becomes the live registry collaboration
serves." Keep collaboration-wired-after-compose.

---

## Guid ownership unification (waves 2 + 5)

**Drift:** Fuji hand-rolls `entryContentDocGuid(id)` = `docGuid({FUJI_ID,
'entries', id, 'content'})`, re-stating the table key and field name that
`.open(connection)` already derives internally. Two owners for one guid; the
strings can drift. No other app does this.

**Decision:** **redesign** — expose `.docs.<field>.guid(rowId)` on the table
handle (pure; available even on the unconnected root so the daemon can read it),
delete Fuji's `entryContentDocGuid`, and make `docGuid` an internal derivation
detail. Single owner: the workspace.

---

## Wave 5 — Svelte child-doc resource lifetime (uniformity)

**Drift:** Three different handle-lifetime idioms across four apps:
- Honeycrisp `NoteBodyPane`, OpenSidian `ContentEditor`: `n(cache, () => id)`
  (the `fromDisposableCache` keyed helper) — the cleanest.
- Fuji `EntryBodyEditor`: hand-rolled `open()` + `$effect` teardown.
- Zhongwen `ConversationView`: hand-rolled `open()` + `onDestroy` teardown.

And two updatedAt idioms: `onLocalUpdate` (Fuji, OpenSidian) vs explicit
`update()` at action boundaries (Honeycrisp, Zhongwen). The latter split is
honest (a chat row's recency is the *send* event, not every keystroke), so it
stays. The handle-lifetime split is not.

**Decision:** **redesign** — route every component's child-doc handle through the
`n()` keyed helper so all four apps own child-doc lifetime the same way.

---

## Wave 3 — lifecycle / disposal / wipe ordering

**Decision:** **keep.** `open(connection)`'s teardown is one explicit ordered
sequence: `runtime[Symbol.dispose]()` (extras that read child docs, e.g.
OpenSidian's sqliteIndex) → `disposeChildDocs()` (the per-field caches) →
`workspace[Symbol.dispose]()` (root ydoc). `wipe()` runs that teardown, awaits
idb + collaboration disposal, then drops owner-scoped storage. This is an
explicit lifecycle, not "cleanup because ordering is implicit"; extras-before-
child-docs-before-root is the correct dependency order.

## Wave 6 — lower-level primitives

**Decision:** **keep, honestly named.** `createWorkspace` (root constructor,
called directly by todos/wiki/whispering and under `open()`), `createChildDocs`
(bound child-doc runtime, used by `open(connection)` and the skills/filesystem
packages), `connectDoc`, and `satisfiesWorkspace` (daemon `project.ts` spread
idiom) are intentional primitives with real callers, not old-path survivors.

## Final report — kept compatibility paths

- `open()` three overloads — kept (real daemon callers; three return types).
- `createWorkspace` — kept as the low-level root constructor; `open()` is the
  actions-aware front door.
- `createChildDocs` / `connectDoc` / `satisfiesWorkspace` — kept primitives.
- The `onLocalUpdate`-vs-explicit-`update` updatedAt split — kept (honest
  per-app recency policy, not drift).
- Zhongwen `ConversationView`'s `onDestroy(unobserve + clearInterval + dispose)`
  — kept: it is a streaming-transcript view with a liveness ticker, not an
  editor binding, so the `fromDisposableCache` editor idiom does not model it.
- `docGuid` stays exported — `packages/filesystem` and `packages/skills` consume
  it directly.

## Follow-ups (out of this branch's scope)

- `packages/filesystem` (`fileContentDocGuid`) and `packages/skills`
  (`skillInstructionsDocGuid`, `referenceContentDocGuid`) hand-roll the same
  child-doc guid the workspace now owns via `.docs.<field>.guid`. They predate
  this branch. **Trigger to revisit:** when those packages adopt the table
  `.docs` accessor, route their guid derivation through it and consider making
  `docGuid` internal.

## Landed commits

1. `refactor(workspace): namespace row child docs under .docs`
2. `docs(workspace): teach the .docs child-doc accessor`
3. `refactor(workspace): require actions in the compose runtime return`
4. `refactor(fuji): own the entry body handle with fromDisposableCache`
5. `refactor(workspace): drop the ChildDocConnection alias`
6. `refactor(workspace): make the workspace own child-doc guid derivation`
