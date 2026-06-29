# Super Chat, collapsed: one device gateway, two honest vocabularies

**Status**: Draft

**Refines**: the transport of [`20260627T120000-super-chat-cross-device-iroh.md`](20260627T120000-super-chat-cross-device-iroh.md). That spec decided iroh is THE cross-device tool transport. This one collapses *how* the gateway is built after two independent adversarial reviews (one Claude, one Codex) attacked the design for over-layering. The catalog idea, the iroh decision, and the four-ring intent all survive; the plumbing gets smaller.

**Reopens / amends**: [ADR-0073](../docs/adr/0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) under that ADR's own "Trigger to revisit" (the room transport is being redesigned to a direct iroh peer link, exactly the named reopening condition). See [The ADR-0073 amendment](#the-adr-0073-amendment).

---

## Settled refinement (2026-06-29): deployment-not-confidentiality, client shape, and the security boundary

A grilling pass (Claude plus Codex plus web research on the tunnel landscape) settled three things this document had left open. They simplify the spec rather than extend it.

**1. iroh's value is independence and connectivity, not confidentiality.** The earlier framing ("sensitive bytes go straight between your devices, never touching a readable server") does not survive contact with the rest of the system: a tool result is persisted into the synced conversation as a `tool-result` part (`agent/loop.ts`), and conversation bodies sync as plaintext (ADR-0004), so whatever a tool returns reaches the plaintext relay one tick later regardless of how it travelled. iroh therefore earns its keep as the **native, no-server, zero-setup** transport (device-to-device direct, and an "embedded Tailscale" so a self-hosted box is reachable without a VPN), not as a confidentiality boundary. Confidentiality from Epicenter is a **deployment** choice (self-host the box, ADR-0068), never a transport trick. Invariant 5 is reframed below, and the "never touches a readable server" claim is withdrawn.

**2. Client shape: native everywhere by default, with a room-proxy as the only future web path.** The entire browser/tunnel/proxy sub-problem exists solely because of a zero-install web client; refusing that one requirement collapses it.

- **Native-everywhere (the default), Tauri plus bundled iroh.** Wrap desktop and mobile clients in Tauri (Tauri 2 targets iOS and Android) and bundle iroh, so every client is native and reaches devices directly over iroh: no tunnel, no cloud proxy, no public URL, no third party on the path. The most trustworthy shape (fewest parties), and it matches Whispering already being a Tauri app. Honest cost: app-store distribution and Tauri-mobile maturity. This is the only genuinely new engineering; the transport design is done.
- **Room-proxy (deferred), only if a zero-install web client becomes a real product need.** A browser cannot be dialed (the sandbox has no UDP and no inbound socket), so it is always server-mediated. Reuse the room WebSocket the device already holds: the cloud forwards the browser's requests down it and correlates replies with a request-id map (a trimmed resurrection of the deleted `dispatch.ts`, about 50 lines). No new connection, hostname, cert, or third party. Acceptable because ADR-0004 already trusts the relay with plaintext.
- **HTTP tunnel (self-host only),** for a self-hoster who explicitly chooses to expose their own box to a browser. Pangolin (self-hosted: WireGuard plus identity plus auto-SSL) or frp (boring, high-scale) are the picks; Cloudflare Tunnel works but knowingly adds Cloudflare as a TLS-terminating, plaintext-capable party. Never Epicenter's default.

**Refused outright (the browser fork is closed):** WASM iroh in the browser (own a WASM build, relay-only, a flaky callee on mobile Safari) and sealed-room rendezvous (net-new HPKE/X25519 sealing the repo does not have, revives the deleted async-over-doc tier, and still puts the relay on the tool path). Both lose to native-everywhere.

**3. The security boundary is the MCP endpoint, never the URL, tunnel, or relay.** A public or proxied URL to a tool server is unsafe no matter what sits in front of it unless the endpoint authenticates every request. The mandatory floor on every remote tool call, identical across all client shapes: a per-request, audience-bound, short-lived `Authorization: Bearer` (in the header, never the query string) plus `Origin` validation for Streamable HTTP. Front gates (Cloudflare Access, Pangolin auth, the iroh allowlist) are defense in depth, never the sole authority. On the native iroh path this floor is met by Ring 0 (the Ed25519 allowlist); the moment any HTTP-reachable path exists the endpoint bearer check is what actually holds.

---

## Greenfield north star (2026-06-29): one relay, two channel shapes, iroh as an optimization

Taken to its greenfield conclusion, the refinement above collapses one more level. Every cross-device need is the same act: reach a named route on a device over a connection that device already holds. So the architecture has exactly one coordination primitive, and this is the destination the implementation walks toward.

**One primitive: a per-user, authenticated, self-hostable relay** that routes typed channels to a person's devices over the single outbound connection each device holds. Sync was never special; it was always the first channel. This relay is the same node as the anchor (it holds the doc) and is what the room already is (it relays sync today); it is *generalized*, not added.

**Two channel shapes are the whole vocabulary:**

- **Convergent stream** (sync): one long-lived, bidirectional, CRDT channel. There is exactly one kind.
- **Request/response to a route** (everything else): MCP `tools/call` (invoke), HTTP services (transcribe/speak), and your-own-box inference are all "send a request to a named route, get a response, possibly streamed." Where the route lives (a device via the relay, a device via iroh, or a cloud URL for hosted inference) is *addressing*, not a second shape.

**One client seam, two transports.** Behind `PeerTransport`: the **relay-channel is the floor** (works for every client, browser or native, with no app required; server-mediated, which a browser requires anyway), and **iroh-direct is a native-only optimization** selected when both ends are native and reachable. This supersedes the "room-proxy as a deferred fallback" framing in the section above: the relay-channel is the floor we build toward, not a contingency. What is deferred is only its implementation order, not its status; the browser is a first-class citizen because it uses the floor.

**iroh is an optimization, not load-bearing, and it is on probation.** Once the relay floor exists and is self-hostable, iroh's only remaining justifications are latency/bandwidth and the one thing the relay structurally cannot do: a LAN or fully offline link with no reachable relay at all (two of your own devices on a home network with no internet). iroh survives if and only if that offline-LAN case is a real requirement, or it earns a measured latency win a self-hosted relay cannot match. Confidentiality is not a justification (withdrawn above), and "no Epicenter server in the loop" is met by self-hosting the relay, not by iroh.

**Privacy is which relay you run** (ADR-0068), never the transport. **The constraint that dissolves:** "the cloud cannot be an iroh peer (no UDP in Workers or Durable Objects)" stops mattering, because the relay is a WebSocket channel router (exactly what a Durable Object is built to be) and was never meant to join the iroh mesh.

The shipping order is iroh-first (it is already proven: the loopback and `local-books mcp` over iroh) walking toward this floor; "native-everywhere by default" is a sequencing choice, not the ceiling. The relay-channel must land as a clean generalization of the room, with sync as one channel among several, never as one-off RPC bolted onto the sync handler: sharing the connection is fine, coupling the channel logic to the sync logic is the trap.

---

## The one-sentence test

You talk to one chat, hands-free; it can run a tool on another of your own devices and read you the answer; the cross-device hop crosses no server in transit (device to device over iroh), and **the UI you wrote never links a native networking library** to make that happen.

The boundary is the native shell, not confidentiality: the gateway/daemon (ADR-0009) owns iroh behind a localhost surface, and under the [native-everywhere client shape](#settled-refinement-2026-06-29-deployment-not-confidentiality-client-shape-and-the-security-boundary) a Tauri app bundles that shell. If the webview or any `apps/*` UI imports `@number0/iroh`, the boundary is in the wrong place; the native shell that bundles it is exactly where it belongs. The answer's bytes are not secret from Epicenter: they persist into the synced plaintext chat, so privacy is self-host (ADR-0068), not the transport.

---

## What the two reviews agreed on, and where they split

Two independent reviews tried to collapse the iroh spec. They **agreed** on the deletions and **split** on the one real design fork. That split is the most useful thing in this document, because it resolves toward an existing house principle ([honest asymmetry over fake symmetry](../docs/adr/), the repo's stated taste): two unlike operations keep two call shapes; you do not invent a mode discriminator to pretend they are one.

**Both reviews agreed (these are settled deletions):**

1. **The app never sees iroh.** The gateway owns the iroh endpoint and exposes a **localhost** surface. Apps reach it at `http://127.0.0.1:<port>/...` (or a local socket) and never link the native dependency. The async dial, NAT hole-punch, key auth, and connection pooling all hide behind that localhost boundary.
2. **The bespoke relay dispatch protocol is a net deletion, not "legacy."** `dispatch.ts`, `dispatch-protocol.ts`, the relay dispatch router, and `DispatchSurface.dispatch` re-implement request correlation, `isError`, and cancellation that MCP already gives you for free over a held connection. They go.
3. **"Four rings" is two real boundaries.** Ring 0 (the iroh allowlist) and Ring 3 (the executor's own guard, e.g. `LOCAL_BOOKS_READ_ONLY`) are the only mechanisms. Ring 1 (exposure) is a config table, not a runtime gate. Ring 2 (approval) is the agent loop's *existing* `ApprovalDecision` UX. Net new authorization code is approximately the allowlist check.
4. **Refuse the generic reverse proxy.** A path/Host-to-any-localhost-port proxy is a VPN in disguise; it will eventually expose the wrong local thing. Use a **named, allowlisted route table**: `local-books`, `ollama`, `speaches`, and nothing else is reachable.
5. **Refuse live presence as the authority.** For 3 to 5 enrolled devices, the **allowlist is the roster**. "Online" means a dial succeeds; "offline" means it times out. Cache each device's `tools/list`. This removes the relay from the tool path entirely.
6. **Do not flatten every device's whole catalog into the model's tool list.** Select a **target device/service first**, then present that narrow catalog. (Codex called this the single biggest asymmetric win; it also collapses the device-qualified-naming problem, see below.)

**Where they split (the one real fork):**

- The **Claude** review pushed maximal: *one* transport, HTTP-over-QUIC for everything; give `local-books` an `--http` mode (MCP Streamable HTTP); make `Connection.baseUrl = iroh://<nodeId>` the single addressing primitive for tools and services alike.
- The **Codex** review pulled back: MCP Streamable HTTP is **heavier**, not lighter (POST+GET, optional SSE, `Mcp-Session-Id`, DELETE lifecycle, protocol-version headers, reconnect semantics, which the published MCP spec confirms). Raw MCP JSON-RPC over a single iroh bi-stream is **smaller** and is exactly the byte channel the proven PoC already drives (`StreamTransport`, ~40 lines). Keep two vocabularies; refuse one universal `Connection` scheme, because `iroh://` in `Connection.baseUrl` is a category leak (static user-typed data vs. async identity/NAT/policy).

**Resolution (this spec picks Codex's shape, and explains why it is not a cop-out):** the unification that earns its keep is the **transport boundary** (one iroh endpoint, one allowlist, one enrollment, the localhost quarantine), not the **payload vocabulary**. Tools are a *catalog you list and call* (MCP); services are a *single endpoint you POST a blob to* (OpenAI-compatible HTTP). Forcing both through one `Connection.baseUrl=iroh://` scheme is precisely the "transport/mode discriminator" the house style rejects. So: **one transport mechanism, two honest vocabularies, addressed through one localhost boundary.** The Claude review's real contribution survives: the gateway's forwarding is the *same dumb-pipe mechanism* whether the payload is MCP-framed or HTTP-framed, so the gateway stays uniform even though the two vocabularies do not merge.

---

## The architecture

```
        YOUR PHONE (or laptop A)                          YOUR LAPTOP B
   ┌───────────────────────────────┐            ┌──────────────────────────────────┐
   │ Super Chat (pure TS, no iroh)  │            │ device gateway (owns iroh)        │
   │                                │            │  - identity: this device's key    │
   │  agent loop (loop.ts)          │            │  - allowlist: my enrolled keys    │
   │   consumes ToolCatalog ────────┼──┐         │  - named route table:             │
   │                                │  │         │      books   -> spawn `local-books │
   │  ToolCatalog impls:            │  │         │                 mcp` (stdio, warm) │
   │   - local in-process actions   │  │         │      whisper -> 127.0.0.1:8000     │
   │   - MCP client over a localhost │  │ iroh   │      ollama  -> 127.0.0.1:11434    │
   │     stream to the gateway ──────┼──┼─QUIC───┼─►  Ring0: reject key not on the    │
   │                                │  │ bi-     │     allowlist BEFORE any byte      │
   │  transcribe()/speak() are      │  │ stream  │         │                          │
   │   fetch() to a localhost HTTP  │  │ (E2E,   │         ▼ (dumb byte pipe)         │
   │   forward the gateway owns ─────┼──┘ direct  │   raw MCP <-> child stdio          │
   │                                │     or      │   raw HTTP <-> local service port  │
   │  device gateway (this device)  │     relay   │                                    │
   │   owns iroh; app hits localhost │    fallback)│   local-books stays PURE stdio,    │
   └───────────────────────────────┘            │   never learns iroh (ADR-0072/0073)│
        app links no native dep                  └──────────────────────────────────┘
```

Read the picture as three facts:

- **Every device runs one gateway.** It is the only thing that links `@number0/iroh`. It owns the device keypair, the enrolled-key allowlist, the named route table, and the iroh connection pool. On the *consuming* side it also exposes the localhost surfaces the local apps hit. This is the ADR-0009 "mandatory daemon" wearing one more hat, not a brand-new noun; `local-books` itself still has no daemon (ADR-0072 holds).
- **Tools ride raw MCP over an iroh bi-stream.** The app opens a localhost stream to its own gateway, names the target (`books`) and device, and runs an MCP `Client` over `StreamTransport` (the proven PoC). The gateway dials the remote device, checks the allowlist, and dumb-pipes the bi-stream to a **warm** `local-books mcp` stdio child (spawn-once, reuse across calls; this is the per-call-spawn deletion Codex asked for, achieved without giving `local-books` a server).
- **Services ride HTTP over a named localhost forward.** `transcribe(blob, connection)` and `speak(text, connection)` are plain `fetch` to `http://127.0.0.1:<port>/<device>/whisper/...`; the gateway tunnels that HTTP over the same kind of allowlisted iroh stream to `127.0.0.1:8000` on the remote device. The existing `ResolvedConnection` clients work **unchanged**; the `Connection` is `{ baseUrl: 'http://127.0.0.1:<port>/<device>/whisper', apiKey? }`. No `iroh://` scheme, no category leak.

The honest asymmetry, stated once: **two vocabularies (MCP for tools, OpenAI-HTTP for services), one transport mechanism (an allowlisted dumb byte-pipe over iroh), one quarantine boundary (the gateway's localhost surfaces).**

---

## The minimal vocabulary (the whole concept set)

1. **`Connection { baseUrl, apiKey? }`** — the addressing primitive for *services* (STT, inference, TTS). Already shipped (`packages/client/src/connection.ts`). A remote service is just a `Connection` whose `baseUrl` is a localhost forward on the gateway. Untouched.
2. **`ToolCatalog { definitions(), resolve() }`** — the transport-blind seam the agent loop already consumes (`packages/workspace/src/agent/tools.ts`). Two impls survive: local in-process actions, and **an MCP client at a target** (localhost stdio for same-machine, gateway-tunneled iroh for cross-device). The loop and the OpenAI provider never change.
3. **The device gateway** — one process per device: iroh endpoint + keypair + enrolled-key allowlist + named route table + connection pool + the localhost surfaces. The only native-dep owner.
4. **Enrollment** — pair two devices by exchanging public keys out of band (QR or paste a ticket). The allowlist *is* the roster. Revocation is deleting a key.
5. **Voice** — `transcribe()` (shipped) in, `speak()` (new, see below) out. Orthogonal to the cross-device story; both are just services.

Everything the original iroh spec layered on top of this (the `TransportId` union, `DispatchSurface`, presence-as-directory, device-qualified naming, the four rings, a server-side TTS requirement) is either deleted below or made optional.

---

## The deletion ledger (what falls out)

Grounded in the current code (verified by subagents against the real files, with `origin/main` as truth; the local `main` ref in this worktree is 114 commits stale, which is why an earlier pass wrongly read `transcribe()` as unmerged: it is on `origin/main`).

**Deleted outright once iroh carries cross-device tool I/O:**

- `packages/workspace/src/document/dispatch.ts` (`runInboundDispatch`, `interpretDispatchResult`, the 5-variant `DispatchError` wire union, `extractCauseString`).
- `packages/workspace/src/document/dispatch-protocol.ts` (the four dispatch frames + `ActionResponseError` / `DispatchErrorWire`).
- The dispatch limb of `open-collaboration.ts` (`dispatch()`, `pendingDispatches`, `settlePendingDispatches`, `handleDispatchResultFrame`, the `runInboundDispatch` branch of `onTextFrame`, `DISPATCH_RESPONSE_CEILING_MS`). The file survives for Yjs sync + presence.
- The relay's dispatch router in `packages/server/src/room/core.ts` (`handleDispatchRequest`, `handleDispatchResponse`, `sendDispatchResult`, `pickRecipient`, the two `dispatch_*` cases).
- `DispatchSurface.dispatch` and the remote arm of `createDispatchToolCatalog.resolve` (rewired to an MCP-over-gateway call).

**Demoted to discovery-only or refused (the relay becomes a phonebook, or leaves the tool path entirely):**

- `presence-protocol.ts` `Peer.actions` (the manifest broadcast). The manifest *is* an MCP `tools/list` fetched on dial; broadcasting it too is two list mechanisms for one fact. Under "refuse live presence," presence reduces to `{ nodeId, online? }` or vanishes.
- The async-job-over-synced-doc tier in `dispatch-catalog.ts` exists because a relay-dispatched sleeping browser worker cannot answer inline. A held iroh bi-stream answers inline or drops; one tier, not two.
- **Device-qualified naming** (`__<shortNode>`, the proto on `proto/super-chat-d1`) exists only for "two devices both expose `close_tabs`." Refused by "select a target device first," which makes collisions impossible by construction. The proto becomes a deferred seam, not a v1 primitive.

**Survives and is reinforced (transport-agnostic, confirmed in code):**

- `agent/loop.ts` (consumes only `tools.definitions()` / `tools.resolve()`; imports nothing from dispatch, presence, or nodeId, so iroh is a genuine drop-in).
- `packages/client/*` (`connection.ts`, `transcribe.ts`, `openai-provider.ts`'s JSON-Schema -> `function.parameters` mapping). These reaching a remote device unchanged is the proof the boundary is right.
- `invokeAction` + each MCP server's own guards (`apps/local-books/src/commands/mcp.ts`), recipient-side, authority of record.
- `node-id.ts` as device identity (now the allowlist key, not a relay route).

---

## Authorization, collapsed to two boundaries

- **Ring 0 — the iroh allowlist (irreducible, ~free).** The gateway authenticates the dialer's Ed25519 key and rejects anything not enrolled **before a byte flows** (iroh's accept hook + `connection.remoteId()`). Enforce twice if you self-host a relay (`AccessConfig::Allowlist`); n0's public relays are fine because a stranger still cannot pass the endpoint allowlist.
- **Ring 3 — the executor's own guard (already exists).** `LOCAL_BOOKS_READ_ONLY` drops `recategorize` from both the catalog and the core; a stale `SyncToken` is a 409. iroh changes none of it.
- **Ring 1 collapses into the named route table** (what the gateway forwards *is* the exposure decision; default closed).
- **Ring 2 collapses into the agent loop's existing approval UX** (`ApprovalDecision = 'auto' | 'ask' | 'deny'`; remote mutations default `ask`; running the verb is the approval, exactly as `recategorize` works today).
- **The endpoint is the boundary, not the transport.** Across every transport (iroh, a room-proxy, or a self-host tunnel) the authority of record on a remote tool call is the MCP endpoint's own check: a per-request, audience-bound, short-lived `Authorization: Bearer` in the header (never the query string) plus `Origin` validation for Streamable HTTP. Ring 0 meets this on the iroh path (the dialer is authenticated by key before a byte flows); any HTTP-reachable path must enforce the bearer check itself, because a URL is never a boundary.

---

## Enrollment and trust: discovery is not authority

The Ring-0 allowlist has to be populated, and that is where UX and security actually collide. Two independent adversarial reviews (Claude + Codex) converged on one correction to the naive "log in and your devices find each other" idea: **discovery and authority are different axes, and conflating them is the bug.**

- **Discovery** (find a candidate device and its current address) is cheap, non-sensitive, and already solved. Each device publishes its iroh `EndpointId` + a friendly label as **one optional field on the existing presence frame** (`presence-protocol.ts` `PeerSchema` / `PresencePublishFrameSchema`). iroh's pkarr/relay resolves the key to a live address. No new roster service, no `Y.Map`, no QR for the default path. **The relay/cloud is allowed to see this** because public keys and labels are not secret.
- **Authority** (is this key allowed, and for which tools) is **not** presence. The relay *authors* the presence broadcast (`server/src/room/core.ts` composes the outbound peer list itself; the client's `presence_publish` is re-emitted inside a server-authored frame), and today's `nodeId` is a client-claimed nanoid with no ownership proof (`node-id.ts`). So **a key appearing in presence is a key the cloud put in front of you, not a key you authorized.** The allowlist is derived from a **persisted trust ledger** in the per-user synced Yjs doc, with three states: `candidate` (seen, not trusted), `roster-trusted` (TOFU, fine for low-risk tools), `verified` (human-confirmed, required for sensitive tools). Presence is only the liveness/candidate signal feeding it.

**The threat that sets the line.** With naive cloud-TOFU, a malicious or compromised cloud injects a rogue `EndpointId` into your presence; your gateway auto-allowlists it; the attacker (holding that secret key) dials you, passes Ring 0, and invokes tools over a perfectly valid E2E iroh link. This is not "the relay can read plaintext" (ADR-0004's accepted concession); it is worse, an *authorization* breach: **the relay becomes an introducer for an authorized attacker.** Acceptable for chat and other low-risk convenience. Not acceptable for `local-books` (financial), a filesystem, or a shell.

**The convenience default and the one-tap hardening.**

- **Default (low-risk tools): roster-trusted TOFU.** Sign in; your device becomes a candidate on your other devices; low-risk tools are reachable without a tap. The cloud is trusted only for convenience enrollment, which is acceptable because it is already in the auth TCB and can only DoS, never read (iroh stays E2E).
- **Sensitive tools require `verified`,** obtained by the cheapest of two human acts, with the cloud out of the trust path: **(i) existing-device approval** (an already-`verified` device taps "trust this device," mapping to real ownership), or **(ii) a SAS compare** (a 6-digit short-authentication-string derived from *both* iroh public keys plus user/room context, shown on both screens, confirmed once). A relay-substituted key yields a different SAS, so the human catches it. SAS defends only the key *binding*, which is the sole thing under attack; it need not hide the key, because the key is public.

**Self-host (ADR-0068).** Same mechanism, different trust deployment. Self-hosted, "the cloud enrolls my devices" means "my own box enrolls my devices" = no third party, so roster-trusted is sound for everything. Hosted, the verification step is what a paranoid user (or any sensitive tool) requires. You do **not** add a self-host *mode*; you add a per-tool sensitivity gate that is a no-op-worth-skipping when you already trust the box.

**Revocation** = set the device to revoked (or delete it) in the trust ledger; the synced doc propagates the removal to every device's allowlist. The stolen device keeps its secret key but no gateway will accept it.

**End-state simplification (optional, not v1): make the iroh public key the device's `nodeId`.** Today's `nodeId` is a random unauthenticated nanoid; deriving it from the device's iroh keypair instead collapses two device identities into one and upgrades the routing label from "claimed, unvalidated" to cryptographically ownable. Clean, but it touches the relay's routing and presence, so it is an end-state move, not a first step.

**Refused** (each either solves discovery-not-trust, or buys confidentiality for a value that is already public, or couples identities that must stay separate): a standalone enrollment/roster service; auto-allowlisting sensitive tools from cloud-writable presence; PAKE/passphrase over the Yjs doc (more friction for a guarantee SAS already gives; keep only for a "do not trust hosted Epicenter" headless mode); WebAuthn attestation (proves account possession, not peer possession); deriving or certifying the iroh device key from the account identity or the secret-vault keyring (couples gateway compromise to account compromise; the device key must stay device-owned and rotatable); pkarr/DHT as a trust mechanism (it is address resolution only); and QR as the default (kept solely as the air-gapped fallback).

## The ADR-0073 amendment

ADR-0073 decided "one MCP vocabulary, **two transports** (MCP point-to-point at the edge, the stateless mesh between your own devices), because the substrate demands it," and refused carrying MCP's session protocol as the inter-device wire. That refusal was **correct for the blind relay** (routes by `nodeId`, always reconnecting, cannot hold a session) and is **wrong for a direct iroh peer link**, which holds exactly the point-to-point session MCP assumes. ADR-0073's own "Trigger to revisit" names this case. Proposed amendment (to graduate into ADR-0073, or a superseding ADR, when this spec lands and is deleted):

> **Amendment (2026-06-29, supersedes the 2026-06-27 draft).** The cross-device tool transport is a **direct iroh peer connection** between a person's own native clients, so MCP's native point-to-point session model is used there as-is: the dialer authenticates by Ed25519 key, opens a bi-stream, and speaks real MCP, with **no** `{ to: nodeId }` envelope and **no** bespoke dispatch protocol. iroh's value is **independence and zero-setup connectivity** (device-to-device with no server in the path, and a self-hosted box reachable without a VPN), **not** confidentiality: a tool result persists into the synced plaintext conversation (`agent/loop.ts`), so the transport was never the confidentiality boundary, and confidentiality from Epicenter is obtained by self-hosting the box (ADR-0068), not by the wire. Invariant 5 is therefore **reframed deployment-driven**, not sensitivity-driven: native clients reach tools directly over iroh, while the synced room carries everything else (including tool I/O for any zero-install web client) in plaintext, within ADR-0004's existing trust. The plaintext relay remains document and presence/discovery infrastructure and the bespoke relay dispatch path is retired. The security boundary on every remote tool call is the MCP endpoint's per-request, audience-bound bearer plus `Origin` check (Ring 0's key allowlist meets it on the iroh path), never the URL or the relay.

What this does **not** change: the model boundary stays OpenAI-compatible (ADR-0050); a foreign MCP host still receives read-only tools with a server-side approval gate (invariants 2 and 4); `defineActions` stays the authoring surface and MCP stays its projection (ADR-0021).

---

## Three visions, and the recommended one

The knobs are the four refusals above. Each vision is a setting of them.

### Vision A — "Voice-first, no cross-device tools yet" (ship this quarter)

The hands-free chat, entirely on hosted services, zero iroh. VAD utterance -> `transcribe()` -> agent loop (local + same-machine stdio tools only) -> stream text -> `speak()`. The conversation table already syncs across your devices, so the chat is multi-device the moment you sign in on your phone. **Refuses:** all cross-device tooling, the gateway, iroh.

- *Enables:* a complete, usable product (a synced chat that listens and talks back) before any P2P plumbing exists.
- *Does not enable:* "ask my laptop's books a question from my phone." Sensitive local tools are reachable only when the chat runs on the same machine.

### Vision B — "The device gateway" (the recommended destination)

Vision A plus one per-device gateway. Cross-device **tools** ride raw MCP over allowlisted iroh bi-streams to warm stdio MCP servers; cross-device **services** (your own whisper/inference box) ride HTTP over named localhost forwards on the same gateway. Allowlist = roster, dial-on-demand, cached `tools/list`, target-device-first selection. **Refuses:** the generic proxy, live presence, device-qualified naming, server-side TTS by default, browser-as-mesh-node (native clients first).

- *Enables:* the full one-sentence test. Your phone privately drives your laptop's `local-books`, E2E, with finance bytes never touching a server that can read them. Your phone reaches your own GPU box for free private transcription by pointing a `Connection` at a localhost forward.
- *Does not enable (deliberately):* a browser tab as a first-class mesh node (that needs the WASM iroh build, relay-only, deferred to Vision C), and "every device's whole catalog auto-merged into one giant tool list" (you pick a device first).

### Vision C — "Ambient, everywhere" (now the client shape, not a far horizon)

Vision B on **native clients everywhere**: wrap desktop and mobile in Tauri and bundle iroh (the [Settled refinement](#settled-refinement-2026-06-29-deployment-not-confidentiality-client-shape-and-the-security-boundary) makes this the **default client shape**), plus friendly device labels and `pkarr`/mDNS discovery so the relay can leave the tool mesh **entirely** for native clients. The browser-as-mesh-node path (WASM iroh) is **refused**, not deferred; a zero-install web client, if ever required, is the room-WebSocket proxy, not a browser iroh peer. Optionally a realtime-voice `Connection` flavor for minimum latency.

- *Enables:* the chat on your phone and desktop as installed native apps, talking to your private device fleet directly over iroh with no server in the path.
- *Does not enable / costs:* app-store distribution and Tauri-mobile maturity (the only genuinely new engineering); a zero-install browser experience is explicitly out of scope for v1 (the room-proxy covers it later).

**Recommended: build A (voice) now, design straight for B, ship native-everywhere as the client shape.** Vision A is shippable and useful alone. B is the cross-device tool vision and every piece of A is forward-compatible with it (the `ToolCatalog` seam, the `Connection` primitive, the gateway boundary). Do **not** build the old hub-room-over-relay tool path on the way, and do **not** build the browser fork (WASM iroh or sealed rendezvous); the prior spec proved the relay tool path is throwaway, and this refinement closes the browser fork.

---

## User stories (what it enables, and pointedly what it does not)

- **"Driving, hands full."** "What did I spend at vendors over $5k last quarter?" The phone hears the utterance (VAD), transcribes it, the loop selects the **laptop / books** target, dials it over iroh (allowlist passes), runs `query` (read-only, auto-approved), and speaks the three rows back. The numbers cross no server in transit (phone to laptop, device to device); their record in the synced chat is plaintext, within ADR-0004, because the transport was never the confidentiality boundary. *Without this: you wait until you are at the laptop, or you paste finance data into a cloud chat.*
- **"Approve a write out loud."** "Recategorize that $1,200 Amazon charge to Office Supplies." Same path, but `recategorize` is a mutation, so the chat asks "Recategorize Purchase 1041 to Office Supplies on laptop-B?" and you say yes. Running the verb is the approval (Ring 2 = the existing UX); the QuickBooks write happens write-through with a fresh `SyncToken`. *Without this: no remote mutation is possible, by design, until you confirm.*
- **"My data, my GPU, my key."** On a train with spotty signal, transcription points at your home box: `Connection.baseUrl = http://127.0.0.1:<gw>/home/whisper`. The blob goes phone -> gateway -> iroh -> your whisper.cpp, E2E, off any vendor, off your credit card. *Without this: the convenient default ships your voice to Epicenter then OpenAI, which is fine but not private; this is the honest privacy path, and it costs real setup.*
- **"A stranger dials my laptop."** Their key is not enrolled. The gateway refuses at the accept hook before a single MCP byte. *Without Ring 0: the relay-era plaintext path could leak tool names and schemas; here the connection dies at the door.*
- **What it deliberately will not do (v1):** merge every device's whole tool catalog into one flat list the model sees (you pick a device first); let a browser tab be a mesh peer (native clients first); keep a live "who's online" light (a dial is the liveness check); auto-run a remote mutation (always `ask`).

---

## Roadmap (smallest first; stop and look between each)

0. **[done]** `local-books mcp` stdio server on `main`; `transcribe()` + hosted STT on `origin/main`; MCP-rides-any-byte-channel proven (`StreamTransport`).
1. **[in progress, `proto/super-chat-gateway-iroh`]** Loopback gateway: two iroh endpoints in one process, ALPN allowlist, raw MCP over a bi-stream to a warm `local-books mcp` child, answering a books query. Then two processes, then two machines on a LAN.
2. **Voice MVP (Vision A):** `speak()` client + a `/v1/audio/speech` hosted gateway (symmetric to `transcribe()`), the voice-loop controller (VAD -> transcribe -> loop -> speak), and the **turn-taking state machine** (barge-in, echo cancellation so TTS does not re-trigger VAD, endpointing, mobile autoplay unlock) which is the real engineering risk and has no prototype. PWA wiring.
3. **The gateway, productized (Vision B):** enrollment (QR/paste), the named route table, target-device-first catalog selection, the MCP-over-gateway `ToolCatalog` arm, retire the relay dispatch path.
4. **Native everywhere (Vision C):** Tauri mobile bundling iroh, device labels, discovery off the relay. The room-WebSocket proxy lands only if a zero-install web client becomes a real requirement; browser WASM iroh and sealed rendezvous are refused, not roadmapped.

---

## What NOT to build (YAGNI)

Multi-user/org sharing, permission delegation, an audit-compliance log, a tool marketplace, generic OAuth consent, a universal "MCP-over-everything" abstraction, cloud-hosted execution, server-side TTS as the default (use `speechSynthesis` first), the WASM browser path before native works, device-qualified naming before two devices actually collide, and live presence before a dial-timeout proves too slow. Keep the domain at *typed tools on enrolled devices, reached through one localhost boundary*; MCP and OpenAI-HTTP are two adapters underneath, not the universe.

Also refused by the [2026-06-29 refinement](#settled-refinement-2026-06-29-deployment-not-confidentiality-client-shape-and-the-security-boundary): a cloud node as an iroh peer (Cloudflare Workers and Durable Objects have no raw UDP socket and load no native module, so a cloud peer would need a container or VM; the cloud is a WebSocket rendezvous only), per-tool sealing or encryption crypto (we are not doing confidentiality over the wire; self-host is the privacy boundary), a standalone HTTP tunnel as the default browser path (self-host opt-in only), WASM iroh in the browser, and sealed-room rendezvous.
