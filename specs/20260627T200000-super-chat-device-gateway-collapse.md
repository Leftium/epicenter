# Super Chat, collapsed: one device gateway, two honest vocabularies

**Status**: Draft

**Refines**: the transport of [`20260627T120000-super-chat-cross-device-iroh.md`](20260627T120000-super-chat-cross-device-iroh.md). That spec decided iroh is THE cross-device tool transport. This one collapses *how* the gateway is built after two independent adversarial reviews (one Claude, one Codex) attacked the design for over-layering. The catalog idea, the iroh decision, and the four-ring intent all survive; the plumbing gets smaller.

**Reopens / amends**: [ADR-0073](../docs/adr/0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) under that ADR's own "Trigger to revisit" (the room transport is being redesigned to a direct iroh peer link, exactly the named reopening condition). See [The ADR-0073 amendment](#the-adr-0073-amendment).

---

## The one-sentence test

You talk to one chat, hands-free; it can run a tool on another of your own devices and read you the answer; the sensitive bytes go straight between your devices, end-to-end encrypted, and **no app you wrote ever links a native networking library** to make that happen.

If an app under `apps/*` ends up importing `@number0/iroh`, the boundary is in the wrong place.

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

---

## The ADR-0073 amendment

ADR-0073 decided "one MCP vocabulary, **two transports** (MCP point-to-point at the edge, the stateless mesh between your own devices), because the substrate demands it," and refused carrying MCP's session protocol as the inter-device wire. That refusal was **correct for the blind relay** (routes by `nodeId`, always reconnecting, cannot hold a session) and is **wrong for a direct iroh peer link**, which holds exactly the point-to-point session MCP assumes. ADR-0073's own "Trigger to revisit" names this case. Proposed amendment (to graduate into ADR-0073, or a superseding ADR, when this spec lands):

> **Amendment (2026-06-27).** For sensitive own-device tools the transport is no longer the room dispatch path; it is a **direct iroh peer connection**, so MCP's native point-to-point session model is used there as-is. Over iroh, Epicenter wraps **no** `{ to: nodeId }` envelope and runs **no** bespoke dispatch protocol: the dialer authenticates by key, opens a bi-stream, and speaks real MCP. The plaintext relay remains **document and presence/discovery** infrastructure (a phonebook: who exists, public keys, labels) and must never carry sensitive tool I/O (ADR-0004). Epicenter still owns enrollment and routing *policy* (the allowlist and the named route table), but not a tools/call wire protocol. Invariant 5 (sensitivity-driven, honestly asymmetric transport) is **reinforced**, not weakened; what changes is that the "second transport" for your own devices is now the iroh peer link, and the bespoke relay dispatch path is retired rather than kept.

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

### Vision C — "Ambient, everywhere" (the long horizon)

Vision B plus the browser path (WASM iroh, relay-only but still E2E, the thing Tailscale structurally cannot do), mobile native bindings, friendly device labels, and `pkarr`/mDNS discovery so the relay leaves the tool mesh **entirely** (presence deleted, not just demoted). Optionally a realtime-voice `Connection` flavor for minimum latency.

- *Enables:* the chat as a browser PWA on any device with no install, talking to your private device fleet.
- *Does not enable / costs:* a permanently-owned WASM transport, the device-label seam, and the realtime-provider lock-in tradeoff (kept optional, never the default, to preserve the swappable-service property).

**Recommended: build A now, design straight for B, treat C as the horizon.** A is shippable and useful alone. B is the actual vision and every piece of A is forward-compatible with it (the `ToolCatalog` seam, the `Connection` primitive, the gateway boundary). Do **not** build the old hub-room-over-relay tool path on the way; the prior spec already proved it is throwaway, and this collapse confirms the relay never carries tool I/O again.

---

## User stories (what it enables, and pointedly what it does not)

- **"Driving, hands full."** "What did I spend at vendors over $5k last quarter?" The phone hears the utterance (VAD), transcribes it, the loop selects the **laptop / books** target, dials it over iroh (allowlist passes), runs `query` (read-only, auto-approved), and speaks the three rows back. The numbers never touched a readable server. *Without this: you wait until you are at the laptop, or you paste finance data into a cloud chat.*
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
4. **Ambient (Vision C):** browser WASM iroh, mobile bindings, device labels, discovery off the relay.

---

## What NOT to build (YAGNI)

Multi-user/org sharing, permission delegation, an audit-compliance log, a tool marketplace, generic OAuth consent, a universal "MCP-over-everything" abstraction, cloud-hosted execution, server-side TTS as the default (use `speechSynthesis` first), the WASM browser path before native works, device-qualified naming before two devices actually collide, and live presence before a dial-timeout proves too slow. Keep the domain at *typed tools on enrolled devices, reached through one localhost boundary*; MCP and OpenAI-HTTP are two adapters underneath, not the universe.
