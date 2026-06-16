# Row child-docs: greenfield clean-break redesign pass

**Date:** 2026-06-15
**Status:** Implemented; one follow-up pass planned (see "Next pass" at the end)
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
(bound child-doc runtime, used by `open(connection)`), `connectDoc`, and
`satisfiesWorkspace` (daemon `project.ts` spread idiom) are intentional
primitives with real callers, not old-path survivors. (The skills and filesystem
packages do *not* yet use `createChildDocs`; they hand-roll the connected path.
See "Lagger sweep" below.)

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
  *(Revisited in "Next pass": only the read is bespoke; the lifetime should
  still unify through `fromDisposableCache`.)*

## Guid-ownership completion pass (closes the follow-up below)

A focused second greenfield pass finished what the follow-up flagged, so guid
derivation now has exactly one owner end to end.

- **Connected child docs wrap the unconnected deriver.** `connectTableChildDocs`
  used to call `docGuid(...)` a second time with the four args the root already
  used. It now spreads the unconnected `table.docs[field]` entry and only adds
  `open`/dispose, and no longer needs `workspaceId`. Sole derivation owner:
  `createWorkspace`.
- **Action context exposes the deriver.** `WorkspaceActionContext.tables` was
  typed `Tables<T>` (a stale under-type) while `options.actions(workspace)`
  already received the `.docs`-bearing `WorkspaceTables<T>`. Widened to match, so
  handlers reach the table-path guid deriver instead of re-importing `docGuid`.
- **filesystem + skills migrated.** `skillsTable`/`referencesTable` declare
  `.childDocs({ … : attachPlainText })`; `filesTable` declares
  `.childDocs({ content: attachTimeline })`. `fileContentDocGuid`,
  `skillInstructionsDocGuid`, and `referenceContentDocGuid` are deleted (the
  filesystem helper had zero production callers); all callers derive through
  `tables.<table>.docs.<field>.guid(rowId)`. Guid strings are byte-identical.
- **`docGuid` is now internal.** Its only caller is `createWorkspace`, so the
  package-barrel export is dropped and the function is marked `@internal`. The
  public contract is the table path.

**User loss:** Three helpers and the `docGuid` export are removed from published
(non-private) `@epicenter/{filesystem,skills,workspace}`. All callers are
in-monorepo and updated in the same break; no guid or wire change.

## Landed commits

1. `refactor(workspace): namespace row child docs under .docs`
2. `docs(workspace): teach the .docs child-doc accessor`
3. `refactor(workspace): require actions in the compose runtime return`
4. `refactor(fuji): own the entry body handle with fromDisposableCache`
5. `refactor(workspace): drop the ChildDocConnection alias`
6. `refactor(workspace): make the workspace own child-doc guid derivation`

Guid-ownership completion pass:

7. `refactor(workspace): wrap the unconnected guid deriver in connected child docs`
8. `refactor(skills): own instruction/reference child-doc guids through the table`
9. `refactor(filesystem): own the file-content child-doc guid through the table`

## Lagger sweep (post-completion stragglers)

A straggler pass after the guid-ownership work closed two stale survivors and
surfaced one deeper gap, recorded here so it does not get lost.

- **Lagger 1 (landed, `637cbc351`):** stale JSDoc in `skills/tables.ts` still
  described the instruction/reference bodies as opened "through the app-owned
  factory" with no mention of the `.childDocs` declarations. Refreshed to name
  the declaration as the child-doc identity owner.
- **Lagger 2 (landed, `ba495ff58`):** `apps/skills`'s `openSkillsBrowser` and
  `apps/opensidian`'s `openGlobalSkills` were near-identical copies. Lifted one
  `openSkillsBrowser` into `@epicenter/skills/browser` (a third entry beside `.`
  and `./node`); both apps import it. OpenSidian's copy was a strict subset, so
  the package opener is a drop-in superset. Deleted the duplicate plus an
  orphaned local `createSkills` re-export (~−55 lines, one source of truth).
  Skills package, `apps/skills`, and OpenSidian all typecheck clean.

### Lagger 3 (OPEN — triggered follow-up): child-doc *lifecycle* is hand-rolled

This sweep and the guid pass unified child-doc **identity** (the guid is derived
through one owner, the table path). Child-doc **lifecycle** is not unified. The
skills and filesystem packages open child docs the *unconnected* way:
`createWorkspace` + manual `attachIndexedDb(ydoc)` + per-child `connectDoc` +
hand-rolled `onLocalUpdate` recency, instead of the workspace's connected
`open(connection)` / `createChildDocs` / `.docs.open` runtime. Verified:
`grep createChildDocs packages/skills` returns zero hits; `skills/browser.ts`
and `skills/node.ts` build their own `*.open(id)` openers.

The seven `onLocalUpdate` recency call-sites (skills `node.ts` ×2 and
`browser.ts` ×2, Fuji `EntryBodyEditor` ×1, OpenSidian `opensidian.browser.ts`
×1 and `ContentEditor` ×1) are a *symptom* of this missing connected path, not a
separate item. They are honest per-app recency policy only because no shared
connected runtime offers the behavior yet.

**Why deferred, not folded in:** this is a real redesign, not a straggler.
Skills does not use the connected `open(connection)` path at all, so routing it
through `createChildDocs`/`.docs.open` is a lifecycle migration with its own
correctness surface (disposal ordering, idb naming, recency semantics). It is
out of scope for an identity-ownership sweep. Pick this up as its own pass.
10. `refactor(workspace): make docGuid an internal derivation detail`

> **Recalibrated below (2026-06-15, "Next pass").** Two of the three things this
> sweep lumped together moved since: `filesystem` migrated to declared
> `touch` and deleted its hand-rolled opener, and `Zhongwen` was recorded
> as a permanent keep in the Final report. The greenfield plan that actually
> closes the remaining laggers is the next section; it supersedes the "kept"
> entries for skills and Zhongwen.

---

## Next pass — child-doc lifecycle unification (greenfield)

**Status:** Planned. Stacked on top of this branch, no history rewrite.

**Recalibrated reality.** The Lagger-3 sweep named three holders of the
hand-rolled child-doc lifecycle. Two resolved on their own:

- **`filesystem` is done.** `filesTable.docs({ content: { layout:
  attachTimeline, touch: 'updatedAt' } })` declares identity *and* recency, and the
  separate `file-content-docs.ts` opener was deleted. Identity and recency are
  both declaration-owned.
- **`skills` is the sole remaining package** that hand-rolls the connected path.
- **`Zhongwen ConversationView` is the sole remaining component** off
  `fromDisposableCache`.

This section closes both.

### Skills — NOT a lagger: a different topology the connected runtime can't serve

**Correction (2026-06-15, verified).** An earlier draft of this section proposed
routing skills through `definition.connect()` / `.docs.open`. That plan is
**blocked by topology** and is recorded here as rejected so nobody retries it.

**What the connected runtime actually is.** `connect()` takes a
`ConnectionConfig` (`server`, `baseURL`, `ownerId`, `openWebSocket`,
`onReconnectSignal`, `deviceId`), and its primitive `connectDoc` wires every doc
to **owner-partitioned `attachLocalStorage` + a relay WebSocket**
(`openCollaboration`). `connect()` *is* the cloud-sync runtime. There is no
local-only `connect()`. (`createChildDocs` was retired in `36d48861`; the runtime
is inline in `connect()` now.)

**What skills actually is.** `openSkillsBrowser()` takes no connection: it wires
plain `attachIndexedDb(ydoc)` + `attachBroadcastChannel` — local persistence and
cross-tab sync, **no auth, no ownerId, no relay**. Skills is the shared
agent-skills catalog, local and broadcast-synced, exported to disk by the node
entry. It is a fundamentally different topology from a per-user cloud workspace.

**Why the migration is not viable.** Forcing skills through `connect()` would:
1. require sign-in (skills works signed-out today) — a behavior regression;
2. open a cloud relay for a workspace that is local by design — wrong topology;
3. switch child idb naming from plain `attachIndexedDb` to owner-partitioned
   `attachLocalStorage`, **orphaning every existing local skill body** — the idb
   parity risk, now confirmed fatal rather than merely "verify before shipping."

And `touch` only fires inside the connected runtime (`workspace.ts:588`),
which skills cannot use — so declaring it on the skills tables would be **dead
config forever**, not "inert until connect." Do not add it.

**Reclassification.** Skills is not a lagger that should adopt an existing
pattern; it is a genuinely different case (like node-batch and Zhongwen's read).
Its hand-rolled child-doc caches exist because **no shared *local* child-doc
runtime exists** — only the cloud one does. The only real, separable items:

- **Tiny, optional:** `instructionsDocs` and `referenceDocs` in `browser.ts` are
  near-identical; they could collapse into one small *local* helper
  (`new Y.Doc({ guid }) + attachIndexedDb + onLocalUpdate`). No topology change,
  no cloud dependency, contained to the package. Worth a few lines if touched;
  not worth a dedicated pass.
- **Real and bigger:** *should the workspace runtime grow a local-only
  `connect()` variant* (idb + broadcast instead of owner-idb + relay) so
  local workspaces like skills get `.docs.open` uniformly? That is a real
  runtime design pass with its own surface (does `ConnectionConfig` become a
  local|cloud union? how is idb naming kept parity-safe across the two?), **not**
  a straggler fix. Park it as a separate spec if the duplication ever spreads
  beyond this one package.

**Decision:** **leave skills as-is.** It is correct, contained, and the connected
runtime genuinely does not fit. Node likewise stays batch (per-op `using` open,
no cache) — the honest shape for one-shot `import_from_disk`/`export_to_disk`.

### Zhongwen — unify the *lifetime*, keep the *read*

**Reconciliation.** Wave 5 said "route every component through
`fromDisposableCache`"; the Final report then carved Zhongwen out as a permanent
keep ("a streaming-transcript view with a liveness ticker, not an editor
binding"). Those contradict. The keep conflated two axes:
- **Lifetime** (open a handle keyed by `conversationId`, dispose on unmount) is
  *identical* to the other three apps. Nothing about it is transcript-specific.
- **Read** (`handle.read()` + `handle.observe()` into `$state.raw`, the 1s
  liveness ticker, `findActiveChatDocGeneration`) *is* genuinely bespoke.

**Greenfield direction:** route the handle through
`fromDisposableCache(zhongwen.tables.conversations.docs.messages, () =>
conversationId)` for compiler-enforced disposal, then layer the streaming read
in a `$effect` that subscribes `handle.observe` and returns its unobserve as
teardown; the ticker stays in its own effect. This deletes the hand-rolled
`onDestroy(unobserve + clearInterval + dispose)` and the
`state_referenced_locally` opt-out, and makes all four apps own child-doc
*lifetime* the same way, which is what Wave 5 actually wanted. The bespoke read
stays bespoke, which is what the Final report was right about.

**Honest caveat:** the component is keyed on `conversationId`, so
`fromDisposableCache`'s reactive re-open never fires within an instance; the
concrete win is the compiler-owned dispose and one uniform idiom, not new
behavior. Small but real, low risk. Supersedes the "kept" entry in the Final
report.

**Parked on a branch collision, not preference.** `spec/vocab-two-boats` holds
the most recent edit to `ConversationView.svelte` (`af9c128b5`, newer than this
branch's lineage), actively reshaping the chat surface for practice lanes. Do
**not** convert the handle lifetime here: it would collide with that branch. The
conversion is small and order-independent, so do it last, on whichever of the two
branches lands later, against the settled file. Do not merge `vocab-two-boats`
into this branch to "get ahead of it" — it is an unrelated feature stream.

### Net result of this pass

After the topology correction, **there is no skills work and no in-branch
Zhongwen work to do.** Both remaining laggers resolved to "leave it," for
different reasons:

- **Skills** — leave as-is (different topology; the connected runtime is
  cloud-only and genuinely does not fit). Reopen only if a local-only `connect()`
  variant is ever specced.
- **Zhongwen** — the conversion is sound but parked behind `spec/vocab-two-boats`
  to avoid a file collision; pick it up on the later-landing branch.

The child-doc redesign on this branch is complete; this section closes the
follow-up by showing both open items are correctly *not* acted on now.
