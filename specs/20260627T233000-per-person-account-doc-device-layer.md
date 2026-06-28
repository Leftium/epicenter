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

**Product sentence.** The per-person *account doc* owns the device roster and
trust ledger; every one of a user's devices enters through the single
coordination box it already syncs through; the gateway does iroh transport, the
account doc does identity and authority, and workspace docs do document data:
three jobs, three owners, never crossed.

### Ownership

| Value | Owner | Kind |
| --- | --- | --- |
| Device identity (`peerId` = iroh public key) | the device's `0600` iroh keyfile (`irohKeyPathFor`, Wave 2) | durable, device-local |
| Roster identity (`peerId -> { label, kind }`) | the **account Y.Doc**, single-writer per device (each device owns only its own entry) | durable, per-person |
| Trust (verify / revoke) | **assertions signed by a verified device's iroh key**, carried in the account Y.Doc; the gateway derives effective trust | durable, per-person, cloud-unforgeable |
| Liveness / reachability | **a dial attempt** + iroh n0 discovery | ephemeral, no channel |
| Transport allowlist | the **gateway**, derived from the verified-assertion set | runtime |
| Workspace data + editing presence | **workspace rooms** | untouched |

### Mechanism

- **Account room.** A reserved `owners/<userId>/rooms/<RESERVED_ACCOUNT_GUID>`
  that every device opens on sign-in: the daemon alongside its mounts, the
  super-chat client on launch. It reuses all existing room machinery (auth via
  the user's bearer, Y.Doc sync, the WebSocket upgrade), so there is **no new
  Durable Object type and no parallel infrastructure**.
- **Self-registration.** On join, a device that holds an iroh key (a *peer*)
  writes its own roster entry to the account Y.Doc: `peerId -> { label, kind }`,
  where `kind` is `daemon` (v1) or `wasm-browser` (Vision C, a first-class
  dialable peer that registers through the *same* path). `label` defaults to the
  device hostname, user-overridable. A device owns and writes only its own
  identity fields; trust is written by *other* devices (Wave 4). A today's browser
  tab on a machine with a daemon is a *client* of that daemon over localhost, not
  a peer; it borrows the daemon's identity and does **not** register.
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

- A trust assertion is an append-only record **signed by the asserting device's
  iroh secret key**: `{ asserter: peerId, subject: peerId, verdict:
  verified|revoked|roster-trust, seq, account, prevHash?, sig }`. `seq` is a
  per-asserter monotonic counter and `account` binds it to this user, so a
  replayed or cross-account assertion is rejected. The signature covers all
  fields. The cloud can drop, reorder, or **replay** assertions (a DoS it could
  already mount by refusing to relay), but it **cannot forge** one: it holds no
  device's secret key (the iroh key is device-owned, never derived from the
  account or the vault, per the parent spec). The signing primitive is
  iroh-native Ed25519 (`SecretKey.sign(message)` / `EndpointId.verify(message,
  sig)`, confirmed in the installed types), so the device's iroh key is both its
  identity and its signing key: no second keypair.
- Each gateway derives its Ring-0 allowlist by a **local reducer that verifies
  signatures** and folds the asserted set into effective trust, rooted in keys it
  already trusts (its own, and devices it has directly paired with: no transitive
  web-of-trust in v1). An entry the cloud injected with no valid signature, or
  signed by a non-trusted key, is ignored.
- This is why trust is **append-only signed assertions**, never a mutable Y.Map
  field: a mutable value is (a) unsigned, so cloud-forgeable, and (b) resolved by
  Yjs's **clientID LWW, not timestamp**, so a concurrent `verify` from a
  higher-clientID device could silently override a `revoke`. Signed assertions are
  conflict-free under CRDT merge (a grow-only set), carry their own authenticity,
  and let the reducer enforce **monotonic revocation**: once a valid `revoke` from
  an authorized asserter is seen, a later or replayed `verify` does not resurrect
  the peer unless a strictly-greater-`seq` signed re-verify supersedes it, ordered
  by the asserter's own counter, never by Yjs's internal clientID.

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
3. The account Y.Doc schema: a roster map `peerId -> { label, kind }`. Each device
   self-registers on join (idempotent upsert of its own entry).
4. Super-chat reads the roster -> shows the user's devices -> **target-device-first
   selection** (pick a device, then its narrow catalog), then dials by `peerId`
   through the local gateway transport (the Wave 1 `PeerTransport` seam).

### Wave 4 — authority (the trust ledger)

1. Trust as **append-only signed assertions** in the account doc (see "Why a
   relayed Y.Doc is safe for trust"), not a mutable enum field. Each is
   `{ asserter, subject, verdict: verified|revoked, clock, sig }`, signed by the
   asserter's iroh key. The gateway derives effective trust per peer: `candidate`
   (no assertion, just seen), `roster-trusted` (self-registered, TOFU, fine for
   low-risk tools), `verified` (a valid `verify` from a trusted asserter),
   `revoked` (a monotonic `revoke`; terminal unless a strictly-later signed
   `verify` from a still-trusted asserter supersedes it).
2. **Root of trust, no circularity:** a gateway implicitly trusts its OWN key, so
   it honors `verify` assertions it signed itself (and, in v1, only those plus
   ones from devices it has directly paired with: no transitive web-of-trust).
   The verify act is a human one: existing-device approval (an already-paired
   device signs a `verify` for the new one) or a SAS compare (the deterministic
   6-digit code over both iroh public keys, ported from `proto-enroll.ts`; a
   relay-substituted key yields a different code, so the human catches it). The
   cloud never authors or alters an assertion.
3. Derive the gateway's Ring-0 allowlist by **verifying the signed assertion
   set**, replacing Wave 1's injected static `() => Set<PeerId>`. Re-read per
   connection so a promotion/revocation propagates without a gateway restart.
4. Sensitive tools (local-books) require `verified`; low-risk tools accept
   `roster-trusted` TOFU (parent spec).

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

## Open sub-decisions (settle during Wave 3)

- The exact reserved account-room guid (a reserved constant; confirm it cannot
  collide with a user workspace guid and passes the relay's safe-segment guard).
- `label` source and edit surface (hostname default; where the user renames a
  device).
- (Resolved.) Browser registration: the roster lists *dialable peers* (iroh-key
  holders). A v1 browser tab borrowing a daemon does not register; a Vision C
  WASM-iroh browser is a first-class dialable peer and registers through the same
  path (`kind: wasm-browser`). See "Self-registration".

## Trigger to revisit

If a person runs several always-on gateways (multiple daemons/roots on one
device, or several machines), revisit whether the account doc should also carry a
"which gateway is primary / which mounts each exposes" index. Out of scope until a
second concurrent gateway per person is a real configuration.
