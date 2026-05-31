# Body docs: the clean break + the encryption gradation

**Date**: 2026-05-30
**Status**: Superseded by
`specs/20260530T230000-bodies-as-generic-doc-opener.md` and PR #1868 for the
mechanism. Do not implement `column.body`, `BodyAttach`, `attachBodyCache`,
`online()`, or any framework-owned body subsystem from this spec. The encryption
posture remains relevant background: live collaborative body content is not an
encrypted row scalar.
**Owner**: Workspace platform

## Relationship to prior specs

```txt
REFINES   20260530T180000-schema-declared-body-docs.md
          Keeps the tripartition (schema owns the guid, app owns the read, runtime
          owns the lifecycle). Changes the API SHAPE: deletes the BodyCodec wrapper,
          names ONE "bring a doc online" composition, folds `touch` into the body
          opener. Adds the encryption decision the 180000 spec left as a "gap".

GROUNDED  keyring trace (this branch), yjs/yjs + jazz + evolu + secsync via DeepWiki,
          comparable-apps survey (Notion/Anytype/Liveblocks/Automerge/Triplit/Instant).
```

## One sentence

Superseded model: the framework does not own body docs at all. Fuji owns its entry
body Y.Doc construction in app code, keyed by `EntryId`; browser code caches them,
and daemon code opens throwaway body docs per row for markdown projection.

Historical rejected model:

A "body" exists because a value you encrypt is a value you can no longer merge
character by character, so the one field that needs live collaboration leaves the
encrypted row and becomes its own CRDT `Y.Doc`; everything else about it (its
location, how to read it, how to bring it online) should be derived or named exactly
once.

---

## Why a body is a separate doc at all (the floor)

Three independent walls force it. Any one of them is sufficient.

```txt
WALL 3  Yjs itself. A live shared type (Y.Text / Y.XmlFragment) survives ONLY as a
        DIRECT value (ymap.set('body', new Y.Text())) or a top-level type. Put it as a
        FIELD inside a plain object value and newer Yjs THROWS "Unexpected content
        type". Verified: rich text must be a direct shared-type value or top-level type.

WALL 2  The YKV row model. A row is stored as ONE opaque value { key, val, ts }; fields
        are not separate Y.Map keys. Even unencrypted, the row is a snapshot and LWW
        clobbers the WHOLE row on conflict. A nested live type cannot exist here.

WALL 1  Encryption. The row value is JSON.stringify'd then XChaCha20-encrypted to bytes
        before it enters the Y.Array. A ciphertext blob cannot hold a live anything.

FLOOR   The physics under all three: you cannot encrypt individual characters/ops and
        still merge them. CRDT merge needs the position ids, parent pointers, and
        logical clocks in the CLEAR. (FHE was measured: 123 MB key for a 32-byte
        register, ~2e9x slower. Dead end.) Mergeable == not value-encryptable.
```

Consequence, and the honest reframe: `column.body()` is not special because it is
rich text. It is special because it is the only field whose storage class is **a live
CRDT doc** instead of **an encrypted scalar in the row**. The day you want a
collaboratively-merged tag list, it faces the same exile. So `column.body` reads as:
"this field lives in its own `Y.Doc`, located by derivation, instantiated on demand."

This matches the converged industry shape: Jazz draws the exact line
(`z.string()` stored vs `co.richText()` live), Anytype draws it (queryable Details
index vs per-object block tree). The split is correct, not over-engineered.

---

## Part 1: the clean break (API shape)

Three subtractions. None changes behavior; each removes a concept.

### Decision 1: pass the read function by value; delete the "codec"

`BodyCodec` is a single-method object (`{ attach }`) wrapping a function that already
exists (`attachRichText`). The word "codec" is wrong (a codec encodes/decodes bytes;
`attachRichText` binds a shared type and reads it). Delete the wrapper and the word.

```txt
DELETE  packages/workspace/src/document/body-codec.ts   (BodyCodec type + richText() factory)
```

```ts
// column/body.ts
// before
export function body<C extends BodyCodec>(codec: C): BodyMarker<C> { return { [BODY]: codec }; }
// after
export type BodyAttach = (ydoc: Y.Doc) => { read(): string };   // read() is the universal contract;
                                                                // editor extras (.binding) are additive
export function body(attach: BodyAttach): BodyMarker { return { [BODY]: attach }; }

// table.ts: bodies become a RECORD keyed by field (the column key is the ONE source
// of truth for the field name; no redundant { field: 'content' } inside the object)
// before
export type BodyField = { field: string; codec: BodyCodec };
definition.bodies: BodyField[]
// after
definition.bodies: Record<string, BodyAttach>   // { content: attachRichText }

// the schema call site
// before
import { richText } from '@epicenter/workspace';
content: column.body(richText()),
// after
import { attachRichText } from '@epicenter/workspace';
content: column.body(attachRichText),
```

```txt
Why:
  - The read function carried by value lets the GENERIC daemon read any app's body by
    CALLING it (codec.attach was already doing this; the wrapper added nothing). No
    registry, no switch, no tag-to-reader map. This is exactly Jazz's co.richText().
  - The record form makes the column key the single field-name source (decision A of the
    180000 spec, made literal). Multi-body-per-table is just more keys.

Refused:
  - A declarative tag { type: 'richText' } + a runtime reader registry. That is the
    registry the collapse spec (20260420T230100) and decision C already refused.
  - Keeping richText()/timeline() as zero-arg factories. A content type earns a factory
    ONLY when it takes OPTIONS (timeline({ ... }), richText({ placeholder })); the value
    passed to column.body is ALWAYS a BodyAttach, never an { attach } object.
```

### Decision 2: one "bring a doc online" composition, used by root AND bodies

The root doc and the body opener run the identical `attachLocalStorage +
openCollaboration`, differing only in `actions`. That duplication is the smell. Name
the pair once; both call it. Both providers are necessary (neither is removable):

```txt
provider   gives                                          drop it and...
idb        local persistence (encrypted at rest), the     no offline, re-fetch every open,
           hydrated doc the editor binds to               stops being local-first
sync       relay connection: cross-device + the daemon    body local-only, daemon blind,
           materializing markdown                          no collaboration
```

They are one concept ("make this Y.Doc live for this signed-in user"), not two knobs.

```ts
// browser.ts
const online = (ydoc: Y.Doc, actions = {}) => {
  const idb  = attachLocalStorage(ydoc, { server, ownerId, keyring });
  const sync = openCollaboration(ydoc, {
    url: roomWsUrl({ baseURL, ownerId, guid: ydoc.guid, deviceId }),
    openWebSocket, onReconnectSignal, waitFor: idb.whenLoaded, actions,
  });
  return { idb, sync };
};

const root = online(workspace.ydoc, workspace.actions);   // root and bodies: SAME function
```

```txt
Why:
  - roomWsUrl already derives from ydoc.guid, so the only real difference between root
    and body was `actions` (root has them; a body never hosts actions, passes {}).
  - The daemon's equivalent is the same shape with a different storage primitive
    (attachYjsLog instead of attachLocalStorage). The runtimes share the COMPOSITION,
    not a forced single primitive. Honest asymmetry, not a mode flag.

Refused:
  - Collapsing idb+sync into one provider. They are two lifecycles with an ordering
    dependency (sync waitFor idb.whenLoaded). Forcing one object would hide the order.
```

### Decision 3: fold `touch` into the body opener; the cache takes ONE injected function

`touch` and `open` were two injected callbacks. Folding the edit-effect into the
opener (which now receives the body's location) drops the cache to a single injected
function, and puts the decision AND the effect in one place the app owns.

```ts
// before: cache takes TWO callbacks; the cache itself knows about onLocalUpdate
attachBodyCache(workspace, { open, touch, gcTime })

// after: cache takes ONE; the app's opener does providers + the edit effect
const bodies = attachBodyCache(workspace, {
  open: (ydoc, { table, rowId }) => {
    const providers = online(ydoc);                       // decision 2
    const off = onLocalUpdate(ydoc, () =>                 // browser-only edit effect
      workspace.tables[table].update(rowId, { updatedAt: DateTimeString.now() }));
    return { ...providers, [Symbol.dispose]: off };
  },
  gcTime,
});
```

The cache's remaining job, fully:

```txt
attachBodyCache(workspace, { open, gcTime }):
  body(table, rowId, field?):
    field   = the table's sole body key, or the passed field
    guid    = bodyGuid(workspaceId, table, rowId, field)        // derived, decision K
    ydoc    = new Y.Doc({ guid })
    content = definition.bodies[field](ydoc)                    // schema attach -> { read, binding }
    runtime = open(ydoc, { table, rowId, field })              // app: providers + effects
    return  { ydoc, ...content, ...runtime, dispose: runtime.dispose? + ydoc.destroy }
    (refcount + gcTime grace via createDisposableCache, unchanged)
```

```txt
Why:
  - The cache no longer imports onLocalUpdate or knows what "touch" means. The browser
    opener registers the bump; the daemon opener does not (it must never write rows).
    The browser/daemon asymmetry lives in the closure, not a cache parameter.
  - The clean-break skill: prefer ONE "bring this doc to life" function over a bag of
    callbacks mirroring internal steps. `open` receives already-decided inputs
    (the location) and returns mechanical lifecycle objects.

Refused:
  - A library default touch `now()`. The stamped clock TYPE differs per app (fuji ISO
    DateTimeString vs an epoch number). The app owns the clock; it lives in app code.

Naming:
  - The cache parameter stays `open` (convention: open* = opens local resources; it
    opens IDB + a websocket). Its contract is documented as "build everything this body
    needs to be live: storage, sync, and any local-edit effects." The shared helper is
    `online(ydoc, actions)` (or inline). The body cache is still `attachBodyCache`
    (attach* = registers listeners at call time, per the attach-primitive contract).
```

### Net deletion from Part 1

```txt
- body-codec.ts deleted (the BodyCodec type, richText()/timeline() factories)
- the word "codec" gone from table.ts, body-doc-set.ts, attach-body-cache.ts, markdown.ts
- definition.bodies: BodyField[]  ->  Record<string, BodyAttach>
- attachBodyCache param `touch` deleted (folded into `open`)
- the idb+sync wiring written ONCE (`online`), used by root and every body
```

---

## Part 2: the encryption gradation (and why Path A is the consumer-friendly choice)

### The fact that decides it: the keyring is server-derived, not user-held

```txt
ENCRYPTION_SECRETS (deployment env)  +  ownerId
      └────────── HKDF ──────────────────┘
                   v
               keyring   ── served at GET /api/session on EVERY sign-in ──> client
                   v
   row VALUES encrypted (XChaCha20) before entering the Y.Array
```

Two consequences:

1. There is NO consumer key-custody risk today. Lose the device / forget the password /
   wipe storage: re-authenticate, the server re-derives the SAME keyring, decrypt
   everything. The only catastrophic secret is `ENCRYPTION_SECRETS`, which is OPERATOR
   infrastructure, not user material.
2. It is therefore NOT zero-knowledge. The relay holds ciphertext (cannot read rows),
   but the OPERATOR holds `ENCRYPTION_SECRETS` and can re-derive the key. The hosted
   README states this: the server can decrypt to power search, AI, and password reset.

So the "E2E key loss = data gone forever" fear describes a posture we have NOT entered.
Today: host-trusted encryption at rest (recoverable, full-featured). Not key custody.

### The gradation

```txt
threat you defend against                  what solves it           user cost
-----------------------------------------------------------------------------------
passive DB leak                            encryption at rest        none (HAVE it)
megacorp data-mining                       self-host OR zero-knowledge  none / key custody
HOSTED operator must be unable to read     zero-knowledge E2E only   key custody + recovery UX
subpoena-proof / zero metadata             ZK + metadata hardening   even more (metadata still leaks)
```

The unlock: **self-hosting delivers third-party privacy WITHOUT the key-custody
catastrophe.** Because the key derives from a deployment secret, the only entity that
can read your data is whoever runs the server. If that is you, "the operator can read
it" means "you can read it", and you still recover by logging in against your own box.
The ONLY niche self-host cannot cover is "private from the hosted operator while using
the hosted cloud", which is exactly the one row that needs real E2E.

```txt
                  reads your data?     key-loss failure          recovery
hosted (today)    Epicenter operator   none (server re-derives)  log in again
self-hosted       only you             none (your server)        log in, restart your box
zero-knowledge    nobody               CATASTROPHIC w/o escrow   recovery code / social recovery
```

### Decision 4: stay on Path A; self-host is the privacy answer; defer sealing; keep ZK possible

```txt
Decision:
  - Keep the row model and the server-derived keyring (host-trusted encryption at rest).
    Do NOT build consumer key management.
  - The privacy story is "own your data; self-host the relay for zero-knowledge", which
    we make easy. This is the mainstream local-first stance (Obsidian's stance).
  - Bodies stay ENCRYPTED AT REST (per-guid IDB), which already exists. Do NOT build
    wire-sealing now. Do NOT architect ZK out: keep body-stream sealing POSSIBLE later.

Why:
  - Self-host = same third-party privacy as ZK, but fails gracefully (a server you back
    up and restart) instead of catastrophically (a key you can never lose). Matches the
    audience and the existing self-hostable team deployable.
  - Given the server-derived keyring, sealing the body WIRE would NOT hide bodies from
    the operator (they hold the key); it would only close a passive relay-leak / daemon-
    log-on-shared-machine gap. Modest defense-in-depth, not privacy. Not urgent.
  - Whole-row LWW, value-encryption, and a structure-visible relay are a MATCHED SET.
    Field-level merge (Triplit/Evolu registers) drags toward per-field encryption and a
    blind relay (Path B). Keeping the row model keeps ONE self-consistent point on the
    gradation, and is fully reversible without touching the body design.

Refused:
  - Zero-knowledge E2E for the hosted cloud now. It is a different product PROMISE ("we
    cannot read your notes") with a key-custody tax (recovery codes / social recovery /
    OPAQUE-derived keys + client search/AI). Take it ONLY if that promise becomes the
    pitch, which for a self-hostable tool may be never.
  - Path B (rows as live Y.Maps, field-level merge) now. Fuji's metadata edits are
    single-author onblur saves; the place real co-editing happens (the body) already
    gets character-level CRDT. Revisit only if heavy CONCURRENT same-row metadata
    editing by multiple parties becomes a product requirement. Jazz is the reference.
```

### Clarification: there is no "resealing"

Encryption is a ONE-SHOT envelope at each EXIT boundary, because the in-memory doc must
hold plaintext to merge.

```txt
   Y.Doc (plaintext in RAM, mandatory for merge)
     |
     +-- bytes leave to DISK  -> sealed (per-guid IDB encryption)   EXISTS today
     +-- bytes leave to WIRE  -> plaintext                          optional; do NOT build now
```

"Sealing" the wire = the SAME envelope the IDB attach already uses, applied to the
websocket. No second pass, no "re-". If ever built, it lives in the body `open` closure
(decision 2) as a property of the sync provider, not a new concept:

```ts
// OPTIONAL future, localized to the sync provider in the body opener:
sync: openCollaboration(ydoc, { url, ..., actions: {}, seal: sealUpdatesV2({ keyring, guid: ydoc.guid }) })
//   relay then holds body ciphertext (like it already holds row ciphertext); the daemon
//   still decrypts (it has the keyring) to materialize markdown.
```

---

## Is a separate doc guaranteed for every `column.body`? Yes.

```txt
column.body(...)  ==  "this field's storage class is a separate live CRDT Y.Doc"
  - the GUID always exists the instant the row does (docGuid(ws, table, rowId, field));
    it is derived, never stored (decision K).
  - the Y.DOC is lazy: instantiated only when something opens it (editor, daemon).
  - in Yjs a guid always names a possibly-empty doc, so "does the body exist" is never a
    question: it is empty until written.
```

---

## What would change our mind

```txt
- Bring back a content-type FACTORY (timeline({...})) only when a content type takes
  OPTIONS. The value passed to column.body stays a BodyAttach, never an { attach } object.
- Build wire-sealing when "a passive relay/DB leak must not expose body plaintext" becomes
  a stated requirement (defense-in-depth), NOT before. It does not buy operator privacy.
- Move to zero-knowledge ONLY if the HOSTED product's pitch becomes "we cannot read your
  notes". Then accept the key-custody tax and adopt the Jazz/secsync model.
- Move to Path B (field-level merge) ONLY if concurrent same-row metadata editing by
  multiple parties becomes real. Multi-device single-user LWW loss is accepted until then.
```

## References

```txt
packages/workspace/src/document/body-codec.ts                  DELETE (Part 1, decision 1)
packages/workspace/src/document/column/body.ts                 BodyAttach by value
packages/workspace/src/document/table.ts                       bodies: Record<string, BodyAttach>
packages/workspace/src/document/attach-body-cache.ts           one `open`, no `touch`
apps/fuji/src/lib/workspace/browser.ts                         `online(ydoc, actions)`, shared
apps/fuji/src/lib/workspace/index.ts                           column.body(attachRichText)
packages/encryption/src/derivation.ts, secrets.ts              server-derived keyring (Part 2)
packages/server/src/routes/session.ts                          /api/session serves the keyring
apps/api/README.md:35-46                                       host-trusted trust model, stated
specs/20260530T180000-schema-declared-body-docs.md             the spec this refines
specs/20260420T230100-collapse-document-framework.md           why the framework must not own Y.Doc
jazz (garden-co/jazz), evolu, secsync (DeepWiki)               E2E reference designs
```
