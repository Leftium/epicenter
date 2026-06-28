# Super Chat: a catalog of your devices' tools, invoked remotely over iroh

**Status**: Draft

**Supersedes**: Part B of [`20260626T194408-local-books-mcp-and-super-chat.md`](20260626T194408-local-books-mcp-and-super-chat.md) (the "per-user hub room over the plaintext relay" transport). That spec's Part A shipped (the `local-books mcp` stdio server is on `main`). This spec replaces only the *transport* story for Part B. The catalog idea survives; what changes is how a remote device is reached.

---

## The one-sentence test

One chat shows every device you own and the typed actions each is exposing right now, and lets you fill in an action's inputs and run it on that device, with the data going straight between your devices end-to-end encrypted, never readable by any server in the middle.

If you find yourself sending financial or secret tool I/O across the existing plaintext Yjs relay to make this work, the transport is wrong (that is exactly why Local Books was barred from the old hub-room design).

---

## Read this first: the mental model, in plain terms

Think of each of your devices as having a **phone number that is also its identity**: a public key. There is no central directory that owns your devices; a device *is* its key.

When your phone's chat wants to run a tool on your laptop:

1. **It dials the laptop's key.** A small coordination server (a "relay") helps the two devices find each other and punch a direct line through your home/coffee-shop NAT. ~90% of the time they get a **direct** connection and the relay drops out entirely.
2. **The call is end-to-end encrypted, always.** Even in the ~10% of cases where a direct line can't be punched and the call stays on the relay, the relay is just forwarding sealed envelopes. It sees *that* your phone talked to your laptop and *how many bytes*, never *what was said*. This is the decisive difference from Epicenter's existing relay, which reads plaintext by design.
3. **Once connected, they speak a language your devices already know: MCP.** The thing you already shipped (`local-books mcp`) is a program that talks MCP over a pipe. We just point that pipe down the encrypted call instead of down stdin/stdout.

The library that gives us all of this — dial-by-key, NAT hole-punching, encrypted relay fallback, allowlisting to only your own devices — is **iroh** (`n0-computer/iroh`), which reached a stable **1.0 on 2026-06-15**. It is not a VPN you install on the OS (that's Tailscale); it's a library that lives *inside* a program. That distinction is the whole reason it fits a browser-based product.

---

## The decision: should you go all-in on iroh from the start?

**Yes for the new capability, no as a big-bang rip-out.** Concretely:

- **The cross-device action catalog is greenfield** (nothing built yet). Build it directly on iroh from day one. Do **not** build a relay-RPC version first and migrate later: that path is throwaway work *and* it structurally cannot carry sensitive data, so it's a dead end for the actual goal.
- **Keep stdio for same-machine tools.** It's simpler, zero-dependency, and already shipped. iroh is for device-to-device only.
- **Keep the existing Yjs/relay for document (CRDT) sync.** That's a separate concern; ADR-0004's deliberate-plaintext stance is about *documents*, and it stays. iroh is an orthogonal, encrypted channel for *tool invocation*.
- So "all in on iroh" means: **iroh is THE cross-device tool transport, from the first line, behind a seam** that keeps stdio and (legacy) relay interchangeable. It does not mean iroh replaces everything at once.

**The one real cost, and how we contain it.** iroh is a Rust library with a Node.js binding. We do **not** sprinkle it into every app (that would drag a native dependency into pure-TS apps and break `local-books`'s single-binary `bun build --compile` property). Instead, **one per-device "gateway" process** owns the iroh node, the device identity, and the enrollment/allowlist, and it *proxies* to the local MCP servers (`local-books`, others) over plain stdio. The native dependency is quarantined to one place; every app stays exactly as it is.

---

## The architecture

```
        YOUR PHONE (or browser)                         YOUR LAPTOP
   ┌──────────────────────────────┐            ┌──────────────────────────────┐
   │ Super Chat                    │            │ device gateway (iroh node)    │
   │  ┌────────────────────────┐  │  iroh      │  - identity: this device's key │
   │  │ FederatedToolCatalog   │  │  QUIC      │  - allowlist: my device keys   │
   │  │  = aggregate tools/list │◄─┼──bi-stream─┼─►- ALPN "mcp"                  │
   │  │    across my devices    │  │  (E2E,     │        │ stdio (local)          │
   │  └────────────────────────┘  │  direct or │        ▼                        │
   │  agent loop (loop.ts)        │  relay-    │   local-books mcp  (pure TS,    │
   │  invoke = tools/call          │  fallback) │   other apps' mcp   unchanged)  │
   └──────────────────────────────┘            └──────────────────────────────┘
        no VPN installed                              no app learns about iroh
```

Two concerns, kept separate (this is the key design move):

- **Discovery / catalog** = metadata: which devices exist, which are online, what tools each exposes, and each tool's typed JSON-Schema input. Cheap. The super-app's catalog is literally *"call `tools/list` on each of my enrolled device gateways and merge the results."*
- **Invocation** = the real data flow. `tools/call` over the iroh bi-stream. This is where the no-plaintext-relay rule lives, and iroh satisfies it by construction.

### Why this maps onto the code you already have

- Your agent loop (`packages/workspace/src/agent/loop.ts`) already consumes a `ToolCatalog = { definitions(), resolve(call) }` and is transport-blind. We don't touch it.
- Your OpenAI-compatible provider (`packages/client/src/openai-provider.ts`) already turns a tool's JSON-Schema input into an OpenAI `function.parameters`. A tool reached over iroh is indistinguishable from a local one at this layer.
- `packages/workspace/src/agent/dispatch-catalog.ts` (`DispatchSurface = { peers.list(), dispatch(request) }`) is the seam. The iroh version is a sibling `ActionTransport`; `resolve()` opens a bi-stream to the owning device and speaks MCP.

### The transport seam (so the agent never cares which transport a tool arrives over)

```ts
type TransportId = 'stdio' | 'iroh' | 'relay';
type Sensitivity = 'public' | 'private' | 'sensitive';

interface ActionTransport {
  id: TransportId;
  list(): AsyncIterable<ActionManifest>;          // discovery: tools/list per device
  invoke(action: ActionManifest, input: unknown,
         ctx: { signal?: AbortSignal }): Promise<ToolOutcome>; // tools/call
}

// One policy object owns ADR-0004: a `sensitive` action may only travel over a
// transport that is E2E. Today that means stdio or iroh, never the plaintext relay.
interface InvocationPolicy {
  pickTransport(a: ActionManifest, ts: ActionTransport[]): ActionTransport;
}

// The agent loop sees only this; it is the existing ToolCatalog shape.
class FederatedToolCatalog implements ToolCatalog { /* fan out list(), route resolve() */ }
```

---

## Authorization: who may connect, see, and run (think in rings)

Authorization is not one gate; it is four rings, outermost first. The rule that keeps it honest: **the network layer authenticates; the tool's own guards remain the authority of record.** Never let the transport become the sole owner of an invariant.

- **Ring 0 — who may connect (transport auth).** Every iroh connection is authenticated by the dialer's Ed25519 public key (NodeId); there is no anonymous connection. The gateway checks that key against an **allowlist of your enrolled device keys** and rejects anything else *before a single MCP byte flows* (iroh's accept hook). Enforce it twice: at the endpoint, and, if you self-host the relay, at the relay (`AccessConfig::Allowlist`). Using n0's public relays is fine: a stranger can use the relay for transport but still cannot pass your endpoint allowlist and still cannot read a byte.
- **Ring 1 — what an enrolled device may see (exposure policy).** Being your device does not mean every tool is reachable. The gateway publishes a **curated subset**: opensidian's `bash_exec` (whole-machine reach) must never be remotely invokable; `local-books query` (read-only) is safe. The gateway decides which local MCP servers and which of their tools are exposed over iroh at all. Default closed.
- **Ring 2 — per-call approval (the human gate).** The agent loop already has it: `ApprovalDecision = 'auto' | 'ask' | 'deny'`, and MCP tools carry `readOnlyHint`/`destructiveHint`. Default: reads run unattended, **remote mutations are `ask`** (a confirm in the chat). For a solo user the prompt lives on the calling device. Running the verb is the approval, exactly as `recategorize` already works.
- **Ring 3 — the executor's own guards (authority of record).** The MCP server still enforces everything it enforces locally: `LOCAL_BOOKS_READ_ONLY` still drops `recategorize` from the catalog AND the core still refuses; a stale SyncToken is still a 409. So even if Rings 0-2 were bypassed, a read-only deployment cannot be made to write. iroh changes nothing here.

**Enrollment and revocation (the only identity system you need).** Pair two devices by exchanging public keys out-of-band: scan a QR or paste a ticket; each device adds the other's key to its allowlist. Trust-on-first-use, but explicit (you scanned it), not blind. Revocation = delete a key from the allowlists. Each device's *secret* key lives in that device's secure storage (a `0600` file like local-books' credentials today; OS keychain when present). No certificate authority, no central revocation server. For a handful of devices this is trivial; that simplicity is the YAGNI boundary.

**The one scaling tension (deferred seam).** Manual peer allowlists are O(devices²): each device must learn each other's key. Fine for 3-5 devices. If it grows, publish a small **device roster** (public keys + friendly labels) as cheap metadata so adding a device backfills everyone. The roster is not sensitive (public keys + names), so it can ride the existing relay/Yjs mesh, which gives the clean split in the next section.

## What this collapses, and what becomes legacy

Grounded in the code today: the relay dispatch path is real and used — `packages/workspace/src/document/dispatch.ts` (`runInboundDispatch`), `dispatch-protocol.ts`, and `collab.dispatch({ to })` (the daemon's `action-handler`), surfaced to the chat through `createDispatchToolCatalog` (wired in `apps/opensidian` and `apps/tab-manager`, today serving mostly *local* actions with peers excluded by `selfNodeId`). So cross-device dispatch is built scaffolding, not yet the headline product. The division of labor after iroh:

- **Reused, reinforced (NOT antiquated):**
  - The `ToolCatalog` / `DispatchSurface` seam — iroh is just a new `ActionTransport` behind it. The agent loop and OpenAI provider never change.
  - **Presence + the device roster** become the *discovery / phonebook* layer: who exists, who is online, public keys, labels. Cheap public metadata; ideal for the existing relay/Yjs mesh.
  - The action registry, `invokeAction`, and each MCP server's own guards — untouched authority of record.
  - **D1** device-qualified names — survive verbatim; needed regardless of transport.
- **Becomes legacy / non-sensitive-only:** the **relay dispatch data path** (`dispatch.ts` / `dispatch-protocol.ts`). It works, but it carries plaintext past the relay (ADR-0004), so it can never be the sensitive-tool path. Post-iroh it is at best the no-VPN-needed, non-sensitive transport.
- **The clean collapse:** **relay = phonebook (discovery + roster + presence), iroh = the encrypted call (all tool I/O).** Reuse what you have for what it is good at; add iroh only where E2E is required.
- **The aggressive option (a real deletion, later):** if all cross-device tool traffic should be E2E, iroh replaces the relay dispatch data path entirely and `dispatch.ts` + `dispatch-protocol.ts` + the relay's dispatch frames get *deleted*. Discovery could also move to iroh (pkarr/mDNS), dropping the relay from the tool-mesh completely. Do not do this until the iroh path is proven in production; flag it as the eventual simplification.

## What is already proven (runnable)

The single riskiest assumption — *"MCP can ride a transport other than stdio, so iroh is a drop-in"* — is **proven**. A real MCP `Server` and `Client` complete `initialize` -> `tools/list` -> `tools/call` over a raw byte channel (two crossed pipes) that is **not** stdio. An iroh bi-stream is the same `{ source, sink }` pair (iroh's `open_bi()` returns a send half and a recv half), so swapping the pipes for iroh is mechanical.

Runnable copy lives in the session scratchpad (`scratchpad/iroh-proto/`). The two files are reproduced here so they survive:

### `stream-transport.ts` — MCP over any byte channel (~40 lines, the whole cost)

```ts
import type { Readable, Writable } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// iroh's connection.open_bi() hands you exactly this: a SendStream (sink) and a
// RecvStream (source). stdio is the same shape (stdin = source, stdout = sink).
export type ByteChannel = { source: Readable; sink: Writable };

export class StreamTransport implements Transport {
  private readBuffer = new ReadBuffer();
  private started = false;
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  constructor(private channel: ByteChannel) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('StreamTransport already started');
    this.started = true;
    this.channel.source.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try { message = this.readBuffer.readMessage(); }
        catch (error) { this.onerror?.(error as Error); return; }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.channel.source.on('error', (e) => this.onerror?.(e));
    this.channel.source.on('close', () => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.channel.sink.write(serializeMessage(message));
  }
  async close(): Promise<void> { this.channel.sink.end(); this.onclose?.(); }
}
```

### `proto.ts` — the proof (run from `apps/local-books`: `bun run proto.ts`)

```ts
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamTransport } from './stream-transport.ts';

// THE WIRE: two byte pipes, crossed = one iroh bi-stream stand-in.
const clientToServer = new PassThrough();
const serverToClient = new PassThrough();
const serverChannel = { source: clientToServer, sink: serverToClient };
const clientChannel = { source: serverToClient, sink: clientToServer };

// REMOTE DEVICE: the same low-level Server shape local-books ships, over a stream.
const server = new Server({ name: 'device-gateway', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'query', description: 'Toy stand-in for local-books query.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    annotations: { readOnlyHint: true, destructiveHint: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `ran on the remote device: "${(req.params.arguments ?? {}).sql}" -> [4000, 1450, 760]` }],
}));

// SUPER APP:
const client = new Client({ name: 'super-chat', version: '0.0.0' });
await server.connect(new StreamTransport(serverChannel));
await client.connect(new StreamTransport(clientChannel));
console.log('tools/list:', (await client.listTools()).tools.map((t) => t.name));
console.log('tools/call:', JSON.stringify((await client.callTool({ name: 'query', arguments: { sql: 'biggest expenses' } })).content));
process.exit(0);
```

Verified output (2026-06-27, SDK v1.29.0):
```
tools/list: [ "query" ]
tools/call: [{"type":"text","text":"ran on the remote device: \"biggest expenses\" -> [4000, 1450, 760]"}]
```

---

## The roadmap (smallest first steps; stop and look between each)

0. **[done]** Local stdio MCP server (`local-books mcp`, on `main`).
1. **[done]** Prove MCP rides any byte channel (the prototype above).
2. **Gateway PoC, two desktops.** Add a tiny Rust (or Node-binding) gateway: an iroh node that accepts a bi-stream with ALPN `"mcp"`, and pipes it to a local `local-books mcp` subprocess over stdio. On the other desktop, a client dials by NodeId and runs the MCP client (the `StreamTransport` above, fed by the iroh stream) -> *answer a books question on laptop B from laptop A, end-to-end, no relay reading it.* Hardcode the two keys.
3. **Enrollment.** Pair two devices by exchanging their NodeId public keys (QR or paste a ticket). The allowlist is "my device keys." This is the only identity system you need for a solo user.
4. **Catalog UI.** Aggregate `tools/list` across enrolled device gateways into the device/action grid. Render each tool's JSON-Schema input as a form. Invoke = `tools/call` over iroh. This is the product the user described.
5. **Multi-MCP per device.** The gateway multiplexes several local MCP servers (by ALPN or a routing prefix), so one device exposes `local-books`, plus others.
6. **Mobile + browser.** Mobile uses iroh's Swift/Kotlin bindings. Browser uses the WASM build (relay-only, but still E2E — the capability Tailscale structurally cannot offer).
7. **Later / when a producer exists.** Device-qualified tool names (the old Part B's **D1** survives unchanged: `close_tabs__laptop` vs `close_tabs__phone`); friendly device labels; sensitivity-policy routing; retire the relay dispatch path.

---

## What NOT to build yet (YAGNI)

Multi-user / org sharing, permission delegation, audit-log compliance, a tool marketplace, generic OAuth consent, a universal "MCP-over-everything" abstraction, cloud-hosted execution, and offline invocation (if the owning device is offline, show stale catalog state and fail clearly). Keep the domain at *typed actions on enrolled devices*; MCP is one adapter underneath, not the universe.

---

## What survives from the old Part B, and what changes

- **Survives:** the catalog concept, device-qualified names (**D1**, already prototyped green on `proto/super-chat-d1`), the `ToolCatalog`/`DispatchSurface` seam, the curated-subset discipline (only publish tools you mean to expose).
- **Changes:** the transport. Out: "hub room + dispatch over the plaintext relay" (couldn't carry sensitive data, which forced Local Books off it). In: iroh bi-streams, E2E by construction, so Local Books is a first-class cross-device citizen instead of an exception.
- **Dissolves:** ADR-0004's constraint *for dispatch* — not by violating it, but by routing dispatch over an encrypted channel the relay cannot read. The plaintext Yjs relay stays for document sync.

When step 2+ lands, graduate the durable decisions (iroh as the cross-device transport; the gateway-proxy factoring; MCP-over-iroh) into an ADR (or amend ADR-0073). Build is gated behind the same wedge trigger ADR-0073 sets: do it when a single cross-device chat is something you will actually use.
