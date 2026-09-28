# 0446. Stores own records and immutable attachments across Local and Personal

- **Status:** Proposed
- **Date:** 2026-09-28
- **Unbuilt:** Canonical Markdown Local storage, declared row attachments, Personal attachment transfer and retirement, and the native layout below.
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) for one synchronized document.
- **Design baseline:** Draft commit `21040b8008` on `braden-w/app-schema-derive-export-import`, particularly `packages/app/README.md`, `src/open-store.ts`, and ADRs 0404, 0419, 0423, 0428, 0430, and 0438. Those draft APIs differ from this checkout. This record describes a target, not shipped behavior or an authorized data migration.

## Context

Whispering records on this device without requiring an account. A person can
copy selected recordings into Personal, keeping the original local recording.
The destination retains its own audio and synchronizes its records. Other
devices download audio when an application requests it.

An application may open several store definitions. Whispering can open its own
recordings and a separate captures store. Definition identity must therefore
remain distinct from the installed application's identity.

Independent blob inventories introduce another identity and lifecycle for an
object that often belongs to exactly one row. Conversely, forcing every Local
record through a synchronization engine provides little benefit when that
store never synchronizes. The common contract is record and attachment
ownership; destinations can use different persistence mechanisms.

## Decision

> A definition identifies a store. Local belongs to the installation's storage
> profile and survives account changes unchanged. Personal belongs to a captured
> account and synchronizes across devices. A table may require one immutable
> attachment per row. Storage owns persistence and transfer; applications choose
> when to copy between destinations.

### Definitions and destinations

Retain `openLocal(definition)` and `openPersonal(definition, { account })`.
Local takes no account and never adopts signed-out data into Personal on sign-in.
Its user-facing destination is "On this device" or "In this browser."
Signing out does not hide this library from another person using the same
OS or browser profile. Account-private unsynchronized structured stores are a
legitimate future capability, deferred until a product requires that isolation.
Do not emulate them with account IDs embedded in definition IDs or a Personal
store whose network is permanently disabled.

Personal captures authority and principal before opening. Changing accounts
never retargets a handle or an in-flight copy. Sign-out and close do not delete
data or prove that pending work reached the authority.

A definition ID names a dataset family and schema, not its owner. Logical
Personal identity includes authority, principal, and definition ID. Physical
replica identity additionally includes the installation's storage profile.
Separate products retain separate files even when they synchronize the same
dataset. Within a runtime, consumers reuse a coordinated owner for the same
address. The storage layer must enforce writer exclusion; this layout does not
promise immediate offline delivery between independent products.

### A row owns one immutable attachment

A table opts in with `attachment: true`. Every newly created row in such a
table requires attachment bytes at creation. Tables without the declaration
have no attachment. `Blob` remains a byte input type; "attachment" names the
ownership relationship. This is a proposed declaration, not a current export:

```ts
const recordings = defineTable({
  fields: { title: field.string() },
  attachment: true,
});
```

Metadata can change. Attachment bytes cannot. The attachment's logical address
is its containing store, table, and row identity; it has no separately mutable
blob-ID field. Retrying publication must prove the same bytes rather than
silently overwrite an occupied address. Creation persists a store-owned immutable
descriptor containing the digest and byte length with the row. Ordinary field
updates cannot change it. Publication retries and downloads validate against
that descriptor. Filenames and extensions are presentation and layout
choices, not permission to supply different bytes.

Removing a downloaded copy does not release the immutable binding. Row IDs
are never reused after deletion. Undo or restoration that recreates a deleted
record creates a fresh row and attachment identity. Replacing content means
creating a new owning row, updating application references, and then deleting
the previous owning row when appropriate.

Updates mutate existing rows and refuse missing identities; they never upsert a
replacement row at the same address. Concurrent edits to a deleted row must not
restore its membership. Test this with the chosen Yjs representation rather than
assuming every CRDT map API provides that behavior.

A `files` table uses this exact mechanism. Other rows can store its row IDs in
ordinary fields. Deleting a referring page does not delete the file row.
Deleting the file row ends its attachment's lifetime even if references remain.
Applications choose whether to prevent deletion, clear references, or display
missing files. The store supplies no implicit reference counting or cascade.
Cross-store references require an explicit destination as well as a row ID.

### Native layout and browser equivalents

Use destination first, then account where applicable, then definition:

```text
<product app-data>/
  local/
    so.epicenter.whispering/
      kv.json
      recordings/
        recording-123.md
        recording-123.webm
      transcriptions/
        transcription-456.md
    so.epicenter.captures/
      kv.json
      captures/
        capture-789.md
  personal/
    <account-key>/
      so.epicenter.whispering/
        store.sqlite
        recordings/
          recording-234.webm
      so.epicenter.captures/
        store.sqlite
        captures/
          capture-890.webm
```

The account key unambiguously encodes authority and principal, preserving their
identity on the target filesystem. It is not an email address. Definition,
table, and row path segments must be validated or encoded, with reserved
internal filenames kept distinct. Local has no hidden account segment.

Local table folders contain canonical Markdown records and same-ID attachment
files. `kv.json` contains canonical KV values. Parse records into an in-memory
view on opening; successful writes update that view. Start without a persistent
query index. Measure startup, query cost, and memory before adding one.
Concurrent external file editing and automatic live merging are not initial
guarantees; reopening rereads valid files without silently dropping invalid ones.

Each Personal definition has its own `store.sqlite`, persisting one Yjs document
for tables and KV, plus durable attachment transfer and deletion bookkeeping.
It is not a relational copy of the application tables or a disposable cache.
Personal table folders hold locally retained attachments and exist only when
needed. There is no duplicate authoritative Markdown or KV JSON representation.

Browser storage preserves these identities and API guarantees without promising
Markdown directories or SQLite as its physical format. Existing store-owned raw
SQL capabilities are separate from this engine database.

### Local writes and interrupted operations

A completed Local creation persists complete attachment bytes before publishing
its Markdown record. The row file is the visible commit point. Edit a record or
KV through atomic single-file replacement with the platform's required durability
steps. Update the in-memory view after confirmed persistence; an uncertain write
requires reconciliation or an error, not a success claim.

Attachment creation exposes an explicit durable completion outcome. A synchronous
row ID or an in-memory transaction is not that outcome. Exact method names can
follow implementation, but the caller must be able to distinguish saved data
from an incomplete or uncertain attempt.

Delete the Markdown record durably before attempting to remove its known
attachment. If row deletion durability is uncertain, retain the attachment.
Derive owned paths from validated identity, not unchecked Markdown filenames.

An interrupted creation or deletion may leave extra audio or temporary files.
Readers ignore temporary files. Do not automatically delete unknown files or
infer that an absent record proves an attachment is safe to sweep while another
writer might be active. Retained orphan bytes are not automatically a recovered
recording in the UI.

Orphan inspection and explicit user-directed reclamation can be added later;
initial storage accepts that these files may accumulate.

No generic Local recovery journal, permanent staging directory, multi-file
transaction, or automatic orphan cleanup is required initially. Same-directory
temporary writes and normal error handling remain necessary. Platform durability
and writer ownership must be verified before claiming crash-safe success.

### Personal synchronization and access

The store synchronizes durably saved Yjs updates while open and connected.
Yjs supplies document merging; Epicenter owns persistence, transport, retries,
authorization, and attachment lifetime. No Yjs protocol change is required.
Attachment bytes never enter the document's update stream.
Client transfer obligations retry while their account-bound store is open and
authorized; closing preserves them for the next opening. This requires no
dedicated browser worker or always-running client service.

Creation first retains complete bytes locally and durably records the row and
upload obligation, or equivalent recoverable state. An authenticated uploader
pushes bytes to the server; the server cannot pull them from an offline device.
Transfer retries use the same immutable destination. A locally saved recording
remains playable while upload is pending. Metadata may arrive on another device
before bytes do; that device reports pending or unavailable content and can
retry. The application must not equate metadata acknowledgement with complete
recording upload. Report complete upload only after both are durably acknowledged.
Metadata acknowledgement comes from Epicenter's durable authority protocol, not
merely a WebSocket send or a Yjs provider's caught-up signal.

Applications request attachments through the owning table and row. Access uses
a retained local file first and downloads on demand when missing. A successful
download is validated and durably published before being treated as retained.
An application can request download ahead of time for offline use. Do not
prefetch every attachment merely because its row synchronized. Initial storage
retains downloaded files without automatic eviction and never treats the only
copy of an unfinished upload as disposable.

Deletion immediately removes the row from the deleting replica's live view.
Persist the row deletion and a reminder identifying its remote attachment as
one recoverable commit before discarding the information needed to finish it.
A restart must preserve both or neither. A client retries the reminder with the
captured authority when connected. Acknowledgement means the server has durably
accepted responsibility for retirement; the client can then remove its reminder.
The server completes byte cleanup independently of that client's continued life.
Repeated retirement requests are idempotent, including after a lost response.

```text
client row deletion + durable reminder
  -> authenticated retirement request
  -> server durably accepts retirement
  -> client clears reminder; server finishes deletion

Yjs row deletion -> other replicas remove the row and release retained bytes
```

Retirement is terminal for that attachment address. The server must reject stale
uploads and ensure an upload already in flight cannot restore a readable object
or leave permanently untracked bytes after deletion. An object DELETE alone is
not that guarantee. Preserve a durable retirement fence or an equivalent proven
protocol; expiry of an upload URL alone does not prove in-flight uploads ended.
No safe finite retirement-retention bound is assumed while offline clients can
return arbitrarily late.
Logically, a remote address is absent, committed to one descriptor, or retired.
Retirement may precede upload and is terminal. Making uploaded bytes readable
must be ordered against retirement, including cleanup of uploads that lose that
race. The implementation must track such unfinished uploads; this record does
not mandate a particular object-store transaction or job system.

A definitive retired response stops transfer retries for that address. Observing
the row's deletion likewise durably cancels its upload obligation before local
bytes are released. A transient missing-object response is not retirement.

Other devices learn row deletion through document synchronization. Their local
removal must tolerate crashes and resume from durable state when necessary.
They do not consume the originating client's reminder queue. Neither an absent
row in a partially loaded replica nor a missing local file authorizes remote
deletion. Sign-out is not row deletion, and offline copies cannot be instantly
revoked. Deletion converges when participants reconnect and cleanup can run.
Local cleanup acts only on files registered as owned by that replica; unrelated
or unregistered files are not inferred to be disposable. Terminal remote fences
have a retained-storage cost; this decision establishes no automatic expiry.

### Copies and initial scope

Copying creates independent destination rows and attachment ownership. Confirm
destination local durability before reporting the copy saved; complete remote
upload is a separate state. Retain the source by default. An application may
subsequently delete it, but the two stores do not share an atomic move.
A generic row copy includes its attachment, not arbitrary referenced rows or
transcription history; the application selects related data explicitly.

An uncertain copy retried after restart may create a duplicate destination.
Exactly-once cross-restart copies, global content deduplication, automatic
attachment eviction, private streaming playback, and huge-file transfers are
deferred. Initial transfers must have a documented enforced size limit selected
before implementation; no numerical limit is established by this ADR. Larger
files do not inherently require a second ownership API.

A top-level remote-only publication service is not needed for row attachments.
Independent publication with a different lifetime remains a separate product
capability if a caller needs it; this record does not silently migrate or delete
existing published URLs.

## Consequences and alternatives

Local can remain readable files while Personal retains offline edits and merges
through Yjs. Both present the same attachment ownership rule. This removes the
need for a separate application-facing attachment inventory: enumerate owning
rows instead. It does not remove transfer state, orphan inspection, or terminal
remote retirement.

Account-partitioned Local would protect distinct local libraries during account
switches but adds a third destination and selection rules. It is deferred for
the stated recording workflow. A standalone mutable blob store permits different
lifetimes but forces recordings to coordinate two owners. One content-addressed
pool saves duplicate bytes but introduces shared reclamation. A server database
with query caching requires a separate durable offline mutation protocol.
These alternatives do not simplify the agreed initial experience.

The current checkout's account-only rule in ADR-0336 and working-copy-only
folder rule in ADR-0337 differ from this proposed Local destination. The draft
baseline also keeps Local in Yjs and uses independent hosted blob URLs. This
record proposes replacing those portions for structured stores and row
attachments. Existing publication capabilities and migration are separate.

## Verification before implementation is complete

- Account changes preserve Local and never redirect Personal work. Multiple
  definitions and separate product replicas do not collide.
- Attachment tables reject creation without bytes, replacement, and reuse of a
  deleted identity; generic files-table references do not create hidden cascades.
- Failure injection around file publication and deletion preserves acknowledged
  Local recordings, tolerates leftovers, and never reports uncertain writes saved.
- Offline creation, restart, retry, and interrupted download preserve local bytes
  and eventually transfer them without exposing incomplete files.
- Offline deletion plus restart retains its reminder. Lost acknowledgements are
  retryable. Delete-before-upload, concurrent upload/delete, and stale retries
  cannot resurrect retired content.
- Metadata can precede audio without claiming playback availability. Another
  device's observed deletion retires its retained copy without accidental uploads.
- Copies preserve the source on failure and state their uncertain-retry duplicate
  behavior. Startup and memory measurements justify any later query index.
