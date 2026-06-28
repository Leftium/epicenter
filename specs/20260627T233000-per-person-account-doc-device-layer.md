# The per-person account doc: where the device roster and trust ledger live

**Status**: Draft

**Refines**: the "Enrollment and trust: discovery is not authority" section of
[`20260627T200000-super-chat-device-gateway-collapse.md`](20260627T200000-super-chat-device-gateway-collapse.md).
That spec decided discovery is ephemeral and cloud-readable while authority is a
persisted per-user synced Yjs doc. This spec resolves *where that per-user doc
lives*, after a scoping correction: the device roster must not ride the existing
per-room document-collaboration presence (a different concern at a different
scope). It picks the greenfield shape and is comfortable with the churn.

**Builds on**: [ADR-0035](../docs/adr/0035-durable-storage-is-one-per-person-coordination-box.md)
(one coordination box per person; every device and worker syncs through it),
[ADR-0073](../docs/adr/0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md)
(iroh peer transport, no bespoke dispatch), and the landed Wave 1 gateway +
Wave 2 daemon-iroh-identity.

---

## The fork this resolves

Cross-device "discovery" (which of my devices/gateways exist, and how to reach
them) has no home in the current relay, which is **strictly per-room**:

- A room is `owners/<userId>/rooms/<guid>` (`packages/server/src/owner.ts`),
  authed per-socket by the user's bearer.
- Presence (`snapshotPeers` / `broadcastPresence` in
  `packages/server/src/room/core.ts`) is computed over **one room's**
  `connections` map. Nothing spans a user's devices across workspaces.
- The daemon joins **one room per mount**
  (`packages/workspace/src/daemon/attach-mount-infrastructure.ts`). There is no
  per-user room today, and no reserved guids exist.

So the parent spec's "add the gateway's key + label to the presence frame" would
bolt a per-USER device roster onto per-ROOM workspace presence. That is wrong on
two counts: it overloads editing-awareness with roster semantics (different
scope), and it only works *within a shared workspace*, so it is not a real
cross-device roster. The roster needs per-person scope, which does not exist yet.

---

## The decision: a per-person account doc

A person's durable state lives in **one coordination box per person** (ADR-0035).
Today that box holds only per-workspace docs. The device roster and trust ledger
are per-person durable state, so they live in **the missing per-person doc inside
the same box**: a reserved **account room** every device joins.

**Product sentence.** The per-person *account doc* carries **one append-only log
of device-signed assertions**; roster, label, and trust are all projections of
one device-local reducer; the cloud can drop or replay an entry but never forge
one; the gateway does iroh transport, workspace docs do document data.

The account doc holds **one structure**, not two. An earlier draft split it into a
mutable roster map (`peerId -> { label }`) plus a separate signed trust log; two
independent grills (Claude + codex) flagged that as a duality smell, a
cloud-forgeable second source of device facts beside the unforgeable one. They are
the same shape (a device asserts a fact about a peer, folded by a reducer), so
they collapse: an identity claim is just an assertion where `asserter == subject`.

### Ownership

| Value | Owner | Kind |
| --- | --- | --- |
| Device identity (`peerId` = iroh public key) | the device's `0600` iroh keyfile (`irohKeyPathFor`, Wave 2) | durable, device-local |
| The assertion log | the **account doc**: one append-only `Y.Array` of device-signed assertions; the cloud relays it, never authors it | durable, per-person, replication-only |
| Roster, label, and trust | a **device-local reducer** that verifies signatures and folds the log into projections | derived, never stored, cloud-unforgeable |
| Liveness / reachability | **a dial attempt** + iroh n0 discovery | ephemeral, no channel |
| Transport allowlist | the **gateway**, a query over the reducer's output plus the tool's sensitivity policy | runtime |
| Workspace data + editing presence | **workspace rooms** | untouched |

### Mechanism

- **Account room.** A reserved `owners/<userId>/rooms/<RESERVED_ACCOUNT_GUID>`
  that every device opens on sign-in: the daemon alongside its mounts, the
  super-chat client on launch. It reuses all existing room machinery (auth via
  the user's bearer, Y.Doc sync, the WebSocket upgrade), so there is **no new
  Durable Object type and no parallel infrastructure**.
- **Self-signed identity claim.** On join, a device that holds an iroh key (a
  *peer*) appends a **self-signed** `identity` assertion to the log: `asserter ==
  subject == peerId`, carrying a `label` (hostname default, user-overridable),
  signed by the device's iroh key. The roster is the reducer's fold of the latest
  valid identity claim per peer, so it is **cloud-unforgeable too** (the bearer-
  authed cloud cannot inject a fake "MacBook Pro" entry as a phishing target).
  A WASM-iroh browser (Vision C) is a first-class dialable peer and registers
  through this same path; a today's browser tab on a machine with a daemon is a
  *client* of that daemon over localhost, not a peer, and does **not** register.
  (`kind` is omitted until a v1 operation branches on it: dialing is uniform, and
  the label already identifies the device.)
- **Dial by `peerId`.** iroh n0 discovery (proven cross-machine in Wave 0)
  resolves the key to a live address, so the roster ships **no `hintAddrs`** over
  the relay. `hintAddrs` stays a Wave 1 dial optimization for the same-LAN direct
  case; it is never persisted in the roster (addresses are ephemeral).
- **`presence-protocol.ts` is not touched.** Discovery is the account doc's
  synced roster; liveness is a dial ("online" = dial succeeds, "offline" = it
  times out, per the parent spec's "refuse live presence"). No presence schema
  field, so per-room workspace awareness is untouched by construction.

### Why a relayed Y.Doc is safe for trust (the security property)

The relay reads and writes plaintext (ADR-0004), so the cloud can read **and
tamper with** the relayed account doc. Therefore the account Y.Doc is **not** the
trust ledger in the security sense, and a mutable `peerId -> trust: verified`
field would be a bug: it would make the cloud an authorization writer. The Y.Doc
**owns replication, not trust semantics**. It is demoted to a *durable,
replicated distribution and query index for a signed trust log*; authority lives
in a **device-local reducer over signed assertions** (Claude + codex agreed on
this exact framing).

- Every assertion is an append-only record **signed by the asserting device's
  iroh secret key**, with one shape and three verbs:
  `{ account, asserter: peerId, subject: peerId, verb: identity|verify|revoke,
  seq, label?, sig }`. `identity` is a self-claim (`asserter == subject`, carries
  `label`); `verify` and `revoke` are cross-claims about another peer. `seq` is a
  per-asserter monotonic counter and `account` binds it to this user, so a
  replayed or cross-account assertion is rejected. (No `prevHash`: per-asserter
  `seq` already orders an asserter's own claims, and the threat model concedes
  cloud-drop, so a hash chain buys nothing.) The cloud can drop, reorder, or
  **replay** assertions (a DoS it could already mount by refusing to relay), but
  it **cannot forge** one: it holds no device's secret key (the iroh key is
  device-owned, never derived from the account or the vault, per the parent spec).
  The signing primitive is iroh-native Ed25519 (`SecretKey.sign(message)` /
  `EndpointId.verify(message, sig)`, confirmed in the installed types), so the
  device's iroh key is both its identity and its signing key: no second keypair.
- A **single device-local reducer** verifies signatures and folds the whole log
  into per-peer projections: the **roster** (latest valid `identity` claim per
  peer) and the **trust state** (below). It is rooted in keys the gateway already
  trusts (its own, and devices it has directly paired with: no transitive
  web-of-trust in v1). An assertion with no valid signature, or signed by a
  non-trusted key, is ignored, so a cloud-injected entry never reaches a
  projection.
- **Trust state collapses to three reducer outputs:** `listed` (a peer with a
  valid self-signed `identity` claim and no verify), `verified` (a valid `verify`
  from a trusted asserter), `revoked` (a valid `revoke`; **monotonic**: once seen,
  a later or replayed `verify` does not resurrect the peer unless a
  strictly-greater-`seq` signed re-verify supersedes it, ordered by the asserter's
  own counter, never by Yjs's clientID). There is no stored `candidate` (an
  unsigned cloud-injected key is simply ignored, not a state) and no stored
  `roster-trusted`: whether a tool accepts a merely-`listed` peer is a **per-tool
  sensitivity policy** (low-risk accepts `listed`; sensitive requires `verified`),
  not a trust level. This keeps the discovery-vs-authority line the parent spec
  drew from blurring back together.
- This is why authority is **append-only signed assertions**, never a mutable
  Y.Map field: a mutable value is unsigned (cloud-forgeable) and resolved by Yjs's
  **clientID LWW, not timestamp**, so a concurrent `verify` from a higher-clientID
  device could silently override a `revoke`. Signed assertions are conflict-free
  under CRDT merge (a grow-only set) and carry their own authenticity and order.

The precise property that keeps the cloud out of the trust path: the cloud can
relay, drop, reorder, replay, or corrupt signed assertions, but it cannot forge
an authorization transition, because every transition must verify under an
already-trusted device iroh key or a human-confirmed SAS binding. That property
lives in the **device-local reducer and signature-verification code**, not in the
substrate. The Y.Doc earns its place only as durable, offline-capable, already-
built per-user distribution and catch-up infrastructure (a new device syncs the
whole signed log on first join; a device can verify/revoke offline and merge
later), which is exactly what the radical alternative (iroh-gossip of the same
signed log) would have to rebuild.

---

## Wave plan (designed together; one home)

### Wave 3 — discovery (the roster)

1. A reserved account-room guid + a `@epicenter/workspace` helper to open the
   account doc for `ownerId = self` via the existing collaboration path.
2. Wire every device to join it: the daemon (in `epicenter daemon up`, beside its
   mounts) and the super-chat client (on sign-in).
3. The account doc schema: **one append-only `Y.Array` of signed assertions**,
   plus the reducer. Wave 3 implements only the `identity` verb and the roster
   projection: each device appends a self-signed `identity` claim on join
   (idempotent: re-append only when its `label` changes). The reducer verifies the
   self-signature, so the roster is unforgeable from day one and the trust verbs in
   Wave 4 are a pure addition, not a rewrite.
4. Super-chat reads the roster projection -> shows the user's devices ->
   **target-device-first selection** (pick a device, then its narrow catalog), then
   dials by `peerId` through the local gateway transport (the Wave 1
   `PeerTransport` seam).

### Wave 4 — authority (verify, revoke, allowlist)

1. Add the `verify` and `revoke` verbs to the **existing** log and reducer (a pure
   addition: Wave 3 already built the signed log, the signature check, and the
   roster projection). Effective trust is the reducer's `listed | verified |
   revoked` (see "the security property"). No new structure, no migration.
2. **Root of trust, no circularity:** a gateway implicitly trusts its own key, so
   it honors `verify` assertions it signed itself, plus those from devices it has
   directly paired with (no transitive web-of-trust in v1). The verify act is
   human: existing-device approval (an already-paired device signs a `verify`) or a
   SAS compare (the deterministic 6-digit code over both iroh public keys, ported
   from `proto-enroll.ts`; a relay-substituted key yields a different code, so the
   human catches it). The cloud never authors or alters an assertion.
3. Derive the gateway's Ring-0 allowlist from the reducer output, replacing
   Wave 1's injected static `() => Set<PeerId>`. Re-read per connection so a
   verify/revoke propagates without a gateway restart.
4. **Tool sensitivity is a policy, not a stored state:** the named route table
   tags each route's required level (low-risk accepts `listed`; sensitive, like
   local-books, requires `verified`). Ring-0 admits a peer for a route iff the
   reducer's state for that peer meets the route's threshold.

---

## Clean breaks and churn (welcomed)

- **New concept:** the per-person account room/doc. It is a genuinely new noun,
  but it is the honest realization of ADR-0035, not a parallel system. Every
  device gaining a second room connection (the account room) is the cost.
- **Untouched:** `presence-protocol.ts`, workspace-room presence/editing
  awareness, browser-app nanoid nodeIds, `loop.ts`, the OpenAI provider, the
  `Connection` primitive, `local-books` (pure stdio).
- **Replaced in Wave 4:** the gateway's injected static allowlist becomes a
  derivation from the account doc's `verified` set.

## Refused (greenfield)

- **A `gatewayPeerId` / `label` field on the per-room presence frame.** Overloads
  editing awareness; only works within a shared workspace; not a real per-user
  roster.
- **A separate `owners/<userId>/account` Durable Object type.** Duplicates the
  room machinery (sync, awareness, auth, upgrade) for no new capability; a
  reserved room *is* the per-person coordination doc.
- **y-protocols awareness for liveness.** Not wired in Epicenter (it uses its own
  relay presence), and "a dial is the liveness check" makes a liveness channel
  unnecessary in v1.
- **Shipping ephemeral `hintAddrs` through the relay.** iroh discovery already
  resolves the key to an address; persisting addresses invites staleness.
- **Putting the workspace/room index or settings in the account doc now.**
  Earned-trigger test: add it only when one has a concrete operation. The account
  doc holds devices only until then.
- **iroh-gossip of the signed trust log with no cloud roster at all** (codex's
  "best radical alternative"). It is the strongest privacy model (the cloud never
  carries authority and can be absent), and it is *equal* on security to the
  account-doc approach, because both put authority in the same signed assertions.
  It loses on everything else: bootstrap, offline convergence, multi-device
  catch-up, and the "new phone while the old laptop is off" case, and it rebuilds
  durable per-user sync the account doc already provides. Deferred, not refused:
  the signed-assertion payload is transport-agnostic, so gossip can become a
  second distribution path later without changing the trust model.
- **A mutable roster map beside the signed trust log** (the collapsed-away
  duality). Two shapes for one fact, one of them cloud-forgeable. The roster is a
  reducer projection of the same log.
- **Stored `candidate` and `roster-trusted` states, `prevHash`, and `kind`.**
  `candidate` is just "ignored"; `roster-trusted` is a per-tool policy, not a
  state; `prevHash` is redundant with per-asserter `seq`; `kind` has no v1
  operation branching on it. Each is added back only when a concrete operation
  earns it.

## Open sub-decisions (settle during Wave 3)

- The exact reserved account-room guid (a reserved constant; confirm it cannot
  collide with a user workspace guid and passes the relay's safe-segment guard).
- `label` source and edit surface (hostname default; where the user renames a
  device).
- (Resolved.) Browser registration: the roster lists *dialable peers* (iroh-key
  holders). A v1 browser tab borrowing a daemon does not register; a Vision C
  WASM-iroh browser is a first-class dialable peer and registers through the same
  self-signed `identity` path. See "Self-signed identity claim".

## Trigger to revisit

If a person runs several always-on gateways (multiple daemons/roots on one
device, or several machines), revisit whether the account doc should also carry a
"which gateway is primary / which mounts each exposes" index. Out of scope until a
second concurrent gateway per person is a real configuration.
