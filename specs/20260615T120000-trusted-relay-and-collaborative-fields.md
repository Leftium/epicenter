# Trusted Relay and Collaborative Child Docs (single path)

**Date**: 2026-06-15
**Status**: Draft
**Owner**: Braden (workspace platform)
**Branch**: TBD
**Supersedes**: `20260614T160000-zero-knowledge-relay-and-collaborative-fields.md` (the ZK append-log design is withdrawn; see Decision)

## How to read this spec

```txt
Read first:
  One Sentence
  Decision: trusted, not zero-knowledge
  Target shape: three layers
  Implementation Plan

Read if changing the architecture:
  Research Findings
  Design Decisions
  Open Questions

Historical / supporting:
  What collapses / What stays
```

## One Sentence

There is exactly one trusted relay that runs Yjs, merges, and reads content; a collaborative body is a child Y.Doc addressed by a stable guid, opened through one bound `session.childDocs` runtime (lifecycle), shaped by an `attach*(ydoc)` layout (shape + writer policy), and declared on a row only for identity + delete-cascade; the server-trust encryption layer (keyring, value-level and update-blob encryption) is deleted, and at-rest protection moves to infrastructure.

## Decision: trusted, not zero-knowledge

"Even logged in, we cannot read your data" was evaluated as a **nice-to-have, not a primary differentiator** for Epicenter. It is not a landing-page reason to choose the product, and the roadmap does not commit to "the server never computes over content forever." Therefore:

- The hosted relay **may read content**. The server is a normal trusted peer.
- The ZK append-log design (`20260614`) is withdrawn. Its dumb-relay rewrite (Wave 1) is reverted.
- Encryption-at-rest for **server trust** (server-blindness) is removed. Encryption-at-rest for **disk theft** moves to infrastructure (see Encryption matrix), not the CRDT wrapper.

Reversibility note: trusted -> opt-in ZK later is additive (a per-corpus encrypted mode). ZK -> server intelligence later is a promise regression. Choosing trusted keeps the door to server-side content features (AI, materialization, search) open, which is the point.

## Research Findings

### Finding 1: `@epicenter/field` is a closed cell palette; `field.richText()` is a category error

`@epicenter/field` is a closed meta-schema (`packages/field/src/field.ts`). Every kind (a) has an at-rest truth that is a plain JSON Schema, (b) maps to exactly one SQLite storage class (`TEXT`/`INTEGER`/`REAL`), and (c) is mutually exclusive with the others so `recognize()` is unambiguous. The full namespace (`packages/field/src/builders.ts:226`) is:

```txt
string url number integer boolean date instant datetime select multiSelect tags json
```

A collaborative body is a separate Y.Doc. It has no JSON-Schema-cell truth and no SQLite storage class. Adding `field.richText()` (returning a live `Y.XmlFragment`) would either be rejected by `recognize()` and degrade to raw, or force a fake storage class. **Conclusion: child docs are a different axis from cells. Declaration belongs at the table/document level, not inside the `field.*` cell palette.**

### Finding 2: the layout-over-doc pattern already exists (the IoC is composition, not invention)

The three layers the design needs are already built; they are just not wired together:

| Concern | Owner | Status |
| --- | --- | --- |
| **Lifecycle** (refcount, grace, dedup, dispose) | `createDisposableCache` (`packages/workspace/src/cache/disposable-cache.ts`) | exists |
| **Shape** (Y.Doc layout) | `attachPlainText(ydoc)` (`attach-plain-text.ts`), `chat-doc.ts` free-functions over a `Y.Doc` | exists (text, conversation) |
| **Identity** (the guid) | `zhongwenConversationDocGuid` (`apps/zhongwen/zhongwen.ts:109`) | exists, hand-wired per app |

`createDisposableCache(build, { gcTime })` already separates lifecycle (the cache) from shape (the `build` closure): shape is injected, lifecycle is owned. `attachPlainText` is already a layout (`attach*(ydoc) -> handle`). `chat-doc.ts` is the conversation layout, already functions over a doc. The work is naming and composition.

**Caveat from `chat-doc.ts:46`:** a layout encodes *writer policy*, not just shape ("Single writer per map: the creating client for user messages, the server generation actor for assistant messages"). A generic "child doc of any shape" abstraction must not erase this, or it invites two-writer corruption. A layout owns shape AND who-may-write-what; that is why `text` / `richText` / `conversation` are not interchangeable knobs.

### Finding 3: trusted unlocks stored-id child docs (1:N, relocatable, nested)

A blind relay cannot follow a child id stored in a parent doc (it can't read the parent), which is why Zhongwen is forced into a deterministic *derived* guid and a structural 1:1 relationship. A trusted relay can read the parent, so a field may store an arbitrary set of child-doc ids: 1:N, relocatable, and nestable (a child doc's own field stores grandchild ids). The trust decision does not just delete the keyring; it *enables* the more composable identity model.

### Finding 4: the encryption wrapper does not provide transit or CRDT logic

Audit of `createEncryptedYkvLww` (`packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`): it encrypts cell *values* at the CRDT boundary (`set` encrypts into the Y.Array, `get`/observer decrypts). It does NOT provide transport encryption (that is TLS on the WebSocket, a separate layer) and does NOT provide conflict resolution (that is the inner `YKeyValueLww`, which stays). Deleting the wrapper loses only: at-rest value encryption (server-blindness), the keyring, and the "unreadable cell" failure class. The bare `YKeyValueLww` is already a drop-in (`workspace.ts:193-196`).

### Encryption matrix (what each layer protects, after this change)

| Layer | Provider | Status after change |
| --- | --- | --- |
| In transit | TLS (wss:// / HTTPS) | Unchanged, always on |
| CRDT merge / LWW | inner `YKeyValueLww` | Unchanged |
| At rest, server | infra (Cloudflare DO/R2 platform encryption or KMS) | Encrypted at rest, server-readable in memory |
| At rest, client (IndexedDB) | OS full-disk encryption (FileVault/BitLocker) | App-level encryption dropped (see Open Questions) |
| Server-blindness (ZK) | (removed) | Deleted on purpose |

## Target shape: three layers

```txt
declare (identity + cascade)        open (lifecycle)            shape (+ writer policy)
─────────────────────────────       ──────────────────         ────────────────────────
row field OR derived convention  ->  session.childDocs(guid) ->  attach*(ydoc) layout
  derives/stores the guid             createDisposableCache       attachPlainText  (text)
  delete() drops the id ref           refcount + grace + GC       attachRichText   (richText, TODO)
  NOT a member of field.*             config pre-bound            attachChatTranscript (conversation)
```

- **Lifecycle** is one runtime: `session.childDocs(build)` over `createDisposableCache`, with server/ownerId/url/openWebSocket/deviceId pre-bound. Same guid -> one shared Y.Doc; N opens require N disposes; grace window survives route/pane swaps.
- **Shape** is an `attach*(ydoc)` layout that owns the CRDT layout and its writer discipline. `attachPlainText` exists; `attachChatTranscript`/`chat-doc.ts` exists; `attachRichText` (Y.XmlFragment) is the one to add for prose bodies.
- **Identity** is either a *derived* guid (row + literal field name; stores nothing; 1:1; invisible to SQL) or a *stored id* cell (`field.string()`/`field.json()` holding the child id; 1:N; relocatable; queryable in SQL). This is the one genuine fork (Open Question 2).

This is **not** the deleted `defineDocument` contract: no handle brand, no `DocumentFactory`, no `ActionIndex`. It is a cache, a set of `attach*` layouts, and a thin row-declaration for cascade.

## The row-declaration (replaces `field.richText()` as a field member)

The common single-body case (Fuji, Honeycrisp, Opensidian, Skills) still wants the body declared on the row so the workspace owns guid derivation, lazy open via `session.childDocs`, disposal, and **structural delete-cascade** (a bare id-keyed factory cannot give the cascade). But the declaration is a child-doc axis, distinct from the `field.*` cell palette:

```ts
// ILLUSTRATIVE — surface is Open Question 1, not settled.
entries: defineTable(
  { title: field.string() },                 // cells: materialize to SQLite
  { body: childDoc(attachRichText),          // child docs: separate axis, cascade on row delete
    code: childDoc(attachPlainText) },
)

using body = ws.entries.open(id).body;       // lazily opens via session.childDocs, returns the layout handle
```

`childDoc(layout)` derives the guid from `(workspaceId, collection, rowId, name)` (derived mode) and binds the cascade. Zhongwen's conversation is the *same* mechanism with a custom layout (`attachChatTranscript`); whether it stays a hand-wired call or becomes a `childDoc(attachChatTranscript)` declaration is Open Question 3.

### Refused

- `field.richText()` / `field.text()` / `field.childDoc()` as members of `@epicenter/field`. Category error (Finding 1). Layouts are `attach*(ydoc)`; the cell palette stays closed.
- Restoring `defineDocument` as a contract. Custom shapes use the runtime + a layout; they own their reference.

## Child-doc deletion & garbage collection (the cautious path)

Deletion in a distributed CRDT is the hard part (idempotency, the delete-vs-re-add race, real-time cascade). Greenfield decision: **do not solve it in the hot path.** Trust lets us move deletion off the critical path entirely.

- `delete(rowId)` does ONE thing: drop the child-id reference from the parent. It never touches the child doc. The list re-renders without the row immediately, so the user sees it gone at once.
- The child doc becomes an **orphan**: an unreferenced Y.Doc, invisible to the app (nothing can open it), costing only storage.
- **Reclamation is offline mark-and-sweep, run by the trusted server** (the win trust unlocks: a blind relay cannot read parents to know what is referenced; a trusted one can). The sweep reads every parent, computes the set of referenced child guids, and deletes the child DOs not in that set. On a consistent server snapshot there are no races and idempotency is trivial. It is the SAME sweep that clears old encrypted data: one offline GC for both.

| Layer | Reclaimed by | When |
| --- | --- | --- |
| In-memory handle | `createDisposableCache` refcount | already: disposed when no surface holds it (grace window) |
| Server doc (DO) | trusted-server mark-and-sweep | manual script now; scheduled later |
| Client doc (IDB) | accepted dead storage; optional load-time prune | low priority |

This keeps the "two paths delete the child" smell away: the parent table owns the reference; the sweep owns child-doc deletion; they never overlap.

### Accepted downsides (named, per greenfield)

1. **Byte-level deletion is eventually-consistent.** An orphan persists until the next sweep. Acceptable: privacy is explicitly not the moat (see Decision) and the UI shows the row gone immediately.
2. **Client IDB accumulates orphans** until a prune. Negligible; storage cost is low.

### Trigger to upgrade to real-time GC

A compliance/product promise requiring immediate hard delete, material storage growth, or a need to reflect a remote peer's delete in real time. The upgrade is the observer-driven single-owner cascade: `delete()` still only drops the reference, and one observer in `session.childDocs` reacts to the reference dropping by disposing the handle, clearing IDB, and calling idempotent `DELETE-room`. Documented here so it is a known next step, not a redesign.

## What collapses (the deletions this decision authorizes)

| Deleted | Reason |
| --- | --- |
| Update-blob encryption boundary + AAD binding | Server reads plaintext; nothing to encrypt for the relay |
| `createEncryptedYkvLww` value-level encryption | Only existed so the relay couldn't read cells; bare `YKeyValueLww` is a drop-in |
| The keyring: `derive-workspace-keyring`, keyring-mandatory `openWorkspace`, `attach-encrypted-indexed-db` | No server-trust key needed; also deletes the key-recovery problem |
| Wave 1 dumb append-log: offset-cursor sync, checkpoint cache, `append`/`readAfter` room contract | Server runs Yjs again; normal state-vector sync returns |
| Client-mediated AI relocation, peer-continuation machinery | `doc-generation.ts` server peer stays; build nothing new |
| Custody fork: Mailbox vs Actor, two-sources-of-truth, deployable trust-mode table | One trusted relay; deployables differ only in who operates them |

The custody fork and the keyring are the two largest subtractions. The keyring deletion ripples into auth (identity + tokens only), local storage (plain, not encrypted), and onboarding (no recovery-code flow). At-rest protection is not lost; it moves to infra (Encryption matrix).

## What stays

- **Smart Yjs relay** (the pre-Wave-1 behavior): live per-room `Y.Doc`, state-vector sync (STEP1/STEP2), server-side compaction. Revert restores this.
- **Server-side AI** as a Yjs peer: `doc-generation.ts` hydrates a replica, streams tokens into the doc, syncs back. Unchanged.
- **Root metadata doc + lazy body child docs split**: still owns the instant-list-render-with-10k-rows invariant. Bodies remain separate top-level docs (independent guids), lazy-loaded.
- **Dispatch correlation + presence channel**: content-blind, untouched.
- **The `field.*` cell palette**: unchanged and closed; cells continue to materialize to SQLite.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Trusted vs zero-knowledge | 3 taste | Trusted | ZK is a nice-to-have, not a differentiator; trusted keeps server-content features open and is additively reversible to ZK |
| `field.richText()` as a field member | 1 evidence | Rejected | `field` is a closed SQLite-cell palette (`builders.ts:226`); a Y.Doc is not a cell |
| Layout mechanism | 2 coherence | `attach*(ydoc)` | `attachPlainText`/`chat-doc.ts` already are this; one mechanism for simple and custom bodies |
| Lifecycle runtime | 2 coherence | `session.childDocs` over `createDisposableCache` | Cache already separates lifecycle from injected shape; binds the session connection |
| Layout owns writer policy | 1 evidence | Yes | `chat-doc.ts:46` single-writer invariant must survive the abstraction |
| At-rest encryption location | 3 taste | Infra (platform/KMS), not the wrapper | Server-held key makes the wrapper pure cost; infra at-rest is simpler and has no keyring |
| Identity: derived vs stored id | Deferred | Support both | Derived fits Zhongwen 1:1; stored id (newly possible under trust) fits 1:N/nested; pick per declaration |
| Child-doc deletion | 3 taste | `delete()` drops the reference; offline server mark-and-sweep reclaims | Real-time CRDT cascade is the hard problem; trust lets the server GC offline (no races). Accept transient orphans (privacy not the moat) |

## Branch action

1. Preserve the stray working tree first: the 9 modified `packages/server/**` files are an uncommitted append-log experiment (matches the dangling `a841628ef`), on no branch. Commit them to `feat/zk-append-log-relay-wip` before anything, so the experiment is not lost.
2. Clean this branch: `git restore packages/server/...` so `chore/skill-library-composition-audit` is skills-only again.
3. Build forward from `main` (the smart relay already is main; there is nothing to "revert" as a commit). Re-add **`DELETE-room`** as a targeted patch against the smart-relay contract (the orphan-on-delete bug exists under trusted too).

## Implementation Plan

### Phase 0: Preserve + clean (do first)
- [ ] **0.1** Commit the 9 working-tree server files to `feat/zk-append-log-relay-wip`.
- [ ] **0.2** `git restore packages/server/...` on the skills branch.
- [ ] **0.3** Branch `feat/trusted-relay-collab-docs` off `main`.

### Phase 1: Confirm smart relay + DELETE-room
- [ ] **1.1** Confirm client and server speak the same Yjs sync frames on `main` (no half-state).
- [ ] **1.2** Re-add `DELETE-room` as a targeted patch against the smart-relay contract.
- [ ] **1.3** Smoke each app against the relay.

### Phase 2: Delete the encryption layer
- [ ] **2.0** Migration (one-off, manual): a server-side admin script clears every existing room DO (`DELETE FROM updates` / `storage.deleteAll()`). Existing encrypted data is intentionally discarded (accepted). **Correctness caveat**: must run before the plaintext code reads those rooms, or the plaintext reader ingests old ciphertext as Yjs updates (corruption). Client local stores wipe by bumping the IndexedDB DB name (old encrypted DBs orphaned; optional one-time delete). This is the same sweep that later reclaims orphaned child docs (see Child-doc deletion).
- [ ] **2.1** Remove update-blob encryption from the relay channel.
- [ ] **2.2** Delete `createEncryptedYkvLww`; cells sync plaintext via bare `YKeyValueLww`.
- [ ] **2.3** Collapse the now-dead contract: with the wrapper gone, `unreadable` has zero producers (`YKeyValueLww.read()` only returns `present`/`absent`). Reduce `ObservableKvStore` from the `KvRead`/`KvStoredRead` tri-state to `get()`/`has()`; `has` re-aligns with `get() !== undefined`; `size` just counts entries.
- [ ] **2.4** Remove the mandatory keyring from `openWorkspace`; `attachLocalStorage` uses plain IndexedDB; delete `attach-encrypted-indexed-db`, `derive-workspace-keyring`; `attachStore` collapses to `new YKeyValueLww(yarray)` (drop the `workspaceKeyring` param thread).
- [ ] **2.5** Enable infra at-rest encryption (confirm Cloudflare DO/R2 default at-rest, or KMS-wrap the storage key). Client local-at-rest: OS disk encryption (Open Question 4).

### Phase 3: Bound child-doc runtime
- [ ] **3.1** Add `session.childDocs(build)` over `createDisposableCache`, config pre-bound (`attachLocalStorage`, `attachCollaboration`, `onLocalUpdate`).
- [ ] **3.2** Add `attachRichText(ydoc)` (Y.XmlFragment layout) alongside `attachPlainText` and `attachChatTranscript`.
- [ ] **3.3** Port Zhongwen (the proven case) onto `session.childDocs` + `attachChatTranscript`. Prove the composition before generalizing.

### Phase 4: Row-declared child docs (Build, Prove, Remove)
- [ ] **4.1** Add the table-level `childDoc(layout)` declaration (surface per Open Question 1): resolve guid, lazy-open via `session.childDocs`. `delete()` drops the child-id reference only (no cascade; GC reclaims, see Child-doc deletion).
- [ ] **4.2** Port Fuji/Honeycrisp/Opensidian/Skills bodies onto `childDoc(attachRichText)` / `childDoc(attachPlainText)`.
- [ ] **4.3** Materializer observes the layout's signal directly; remove the `updatedAt`-bump-as-signal coupling.
- [ ] **4.4** Verify delete UX: `delete()` drops the reference, the row disappears immediately, the in-memory handle disposes via the cache; the orphaned doc is left for the sweep (Phase 5), not the delete path.

### Phase 5: Garbage collection (offline, not hot-path)
- [ ] **5.1** `DELETE-room` verb on the smart-relay contract, idempotent (deleting an absent room is a no-op).
- [ ] **5.2** Server mark-and-sweep: read parents, compute referenced child guids, delete unreferenced child DOs. Runnable as the same admin script that clears old encrypted data (2.0).
- [ ] **5.3** (Optional) client load-time prune of local IDB docs with no parent reference.

## Edge Cases

### Child doc whose row is deleted while open by two surfaces
1. Two editors open the same body (one shared Y.Doc via the cache).
2. Row deleted in one surface -> only the child-id reference is dropped; the doc is NOT touched.
3. Expected: both surfaces re-render without the row; their handles dispose via the cache when navigated away. The orphaned doc lingers until the sweep. No real-time cascade, so no cross-surface race.

### Stored-id child whose id is dangling
1. A row stores a child id whose doc was never created or already deleted.
2. `session.childDocs(guid)` opens an empty doc.
3. Expected: empty layout (not a crash); a separate reconciliation may prune dangling ids. See Open Questions.

### Materialization of child docs
1. Cells materialize to SQLite; child docs do not (Zhongwen transcript is a Y.Doc, only the list materializes).
2. A generic `childDoc` abstraction is also deciding "child docs are outside the SQL mirror."
3. Expected: explicit. Optionally a derived summary cell (e.g. last-message preview) is written back as a normal cell.

## Open Questions

1. **`childDoc(layout)` declaration surface.**
   - Options: (a) second positional arg to `defineTable` parallel to cells, (b) a `childDocs:` block on the table, (c) no declaration — derived convention + manual open everywhere.
   - **Recommendation**: (a) or (b) so cascade + lazy open are owned by the table; leave the exact shape to the implementer. Keep it OUT of `field.*`.

2. **Identity: derived guid vs stored id.**
   - Derived (row + name): 1:1, stores nothing, invisible to SQL. Stored id (`field.string()`/`field.json()`): 1:N, relocatable, nestable, queryable in SQL.
   - **Recommendation**: support both, chosen per declaration. Zhongwen wants derived-1:1; an Opensidian-style nested workspace wants stored id. Do not pick one globally.

3. **Does Zhongwen's conversation become a declaration or stay manual?**
   - Options: (a) `childDoc(attachChatTranscript)` declaration like the others, (b) keep the hand-wired `zhongwenConversationDocGuid` + manual open.
   - **Recommendation**: once `childDoc(layout)` exists and writer policy is preserved, fold Zhongwen in so it stops being a special case. Defer until Phase 3 proves the runtime.

4. **Client local-at-rest encryption.**
   - Keep an optional device-local encrypted-IDB slice (native only) or rely on OS disk encryption everywhere?
   - **Recommendation**: drop; rely on OS disk encryption. A browser cannot hold a key safely (it would live in the same storage). Revisit for native (Tauri) if a segment needs it; additive, not load-bearing.

5. **Server-side materialization + SQLite-as-truth** (future deepening).
   - Server observes docs and writes SQLite, dissolving the client materializer; bodies hydrated on open, materialized + destroyed on quiesce.
   - **Recommendation**: defer. Real collapse, new architecture; do not bundle with this pass.

## Adjacent Work

- Stored-id reconciliation (prune dangling child ids): folded into the server mark-and-sweep (Phase 5.2); the same pass that reclaims orphans also drops references to docs that never existed.
- Derived summary cells (last-message preview materialized back to SQL): opportunistic; only if a list view needs it.

## Decisions Log

- Keep both derived and stored-id identity modes: Zhongwen genuinely wants derived-1:1, nested workspaces genuinely want stored-id.
  Revisit when: one mode goes unused across all apps after Phase 4.

## Success Criteria

- [ ] One relay; client and server speak the same Yjs sync frames; no half-state.
- [ ] No keyring in `openWorkspace`; `createEncryptedYkvLww`, `attach-encrypted-indexed-db`, `derive-workspace-keyring` deleted; storage is plain.
- [ ] At-rest encryption confirmed at the infra layer (platform or KMS).
- [ ] Server-side AI (`doc-generation.ts`) works unchanged against the restored relay.
- [ ] One `session.childDocs` runtime; per-app cache closures gone.
- [ ] Bodies are `childDoc(attachRichText)` / `childDoc(attachPlainText)`; delete cascades with no orphaned IDB store or live room.
- [ ] `field.*` palette unchanged; no `field.richText()` member; no `defineDocument` contract.
- [ ] Zhongwen transcript runs on the shared runtime (declared or manual) and cascades on conversation delete.

## References

- `packages/field/src/field.ts`, `builders.ts` - closed cell palette (Finding 1)
- `packages/workspace/src/cache/disposable-cache.ts` - lifecycle primitive
- `packages/workspace/src/document/attach-plain-text.ts` - existing text layout
- `packages/workspace/src/ai/chat-doc.ts` - conversation layout + writer policy
- `apps/zhongwen/zhongwen.ts` - the proven child-doc pattern (derived guid)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` - the wrapper to delete (Finding 4)
- `packages/workspace/src/document/workspace.ts:186-197` - `attachStore` (plaintext branch already exists)
</content>
</invoke>
