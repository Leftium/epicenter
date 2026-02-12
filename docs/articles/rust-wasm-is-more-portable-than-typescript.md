# Rust + Wasm Is More Portable Than TypeScript for WebSocket Servers

**Sans-IO architecture + WebAssembly compilation gives Rust sync servers genuine write-once-run-anywhere portability that TypeScript can't match, because every JavaScript runtime invented its own incompatible WebSocket API.**

> The systems language compiles to one binary that runs everywhere. The "run anywhere" language needs a rewrite for every runtime. The irony writes itself.

The standard pitch is that JavaScript runs everywhere: browser, server, edge, mobile. TypeScript adds types; the portability story stays the same. Rust is for systems programming, compiled to platform-specific native binaries. Except when you build a WebSocket sync server and try to deploy it across runtimes, that narrative inverts. Y-sweet's Rust core compiles once to Wasm and runs identically on a standalone Axum server and Cloudflare Workers with Durable Objects. A TypeScript sync server needs four different implementations because Bun, Node, Deno, and Cloudflare Workers each have structurally incompatible WebSocket APIs. Not just different names for the same thing: different execution models, different lifecycle hooks, different upgrade mechanisms.

## Four runtimes, four WebSocket APIs

```typescript
// Bun: handler object, server.upgrade(), auto-101
Bun.serve({
  fetch(req, server) { server.upgrade(req); },
  websocket: { message(ws, msg) { ws.send(msg); } },
});

// Node: external ws library, EventEmitter pattern
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => { ws.on('message', (msg) => ws.send(msg)); });

// Deno: must return the upgrade response manually
Deno.serve((req) => {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.addEventListener('message', (e) => socket.send(e.data));
  return response;  // forget this and the connection dies silently
});

// Cloudflare: Durable Object class, WebSocketPair, hibernation API
export class Room {
  async fetch(req: Request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);  // enables hibernation
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, msg: string) { ws.send(msg); }
}
```

| Runtime | Upgrade | Handler style | External deps |
|---------|---------|---------------|---------------|
| Bun | `server.upgrade(req)` | Object with methods | None |
| Node | Manual via `ws` library | EventEmitter `.on()` | `ws` package |
| Deno | `Deno.upgradeWebSocket()` | `addEventListener()` | None |
| Cloudflare | `new WebSocketPair()` | Durable Object class methods | None |

Same protocol, same bytes on the wire, four incompatible integration points. Move your Bun sync server to Cloudflare Workers and you're not porting; you're rewriting.

## Sans-IO: separate protocol from transport

Y-sweet solves this with a pattern called sans-IO: the core library handles bytes in, bytes out. It never imports a socket, never listens on a port, never reads from disk. Two thin adapters plug in the actual I/O.

```
┌──────────────────────────────────┐
│  y-sweet-core (Rust, sans-IO)    │
│  handle_message(&[u8]) → Vec<u8> │
│  Store trait: get/set/remove      │
│  [compiles to native + Wasm]      │
└──────────┬───────────┬───────────┘
           │           │
    ┌──────▼──────┐  ┌─▼───────────────┐
    │ y-sweet     │  │ y-sweet-worker   │
    │ Axum/Tokio  │  │ Durable Objects  │
    │ S3/FS store │  │ R2 store         │
    └─────────────┘  └─────────────────┘
```

The same `y-sweet-core` crate compiles to a native Rust binary for your VPS and to WebAssembly for Cloudflare Workers. Zero code duplication. The protocol logic, CRDT merges, document persistence: all shared. Only the I/O adapter changes.

This pattern already exists in the Epicenter codebase. The sync server's `protocol.ts` is pure sans-IO without calling it that:

```typescript
// packages/epicenter/src/server/sync/protocol.ts
// "Separates protocol handling from transport (WebSocket handling)."
export function encodeSyncStep1({ doc }: { doc: Y.Doc }): Uint8Array { ... }
export function decodeSyncMessage(data: Uint8Array): DecodedSyncMessage { ... }
export function handleSyncMessage({ decoder, doc, origin }): Uint8Array | null { ... }
```

Pure functions. Accept bytes, return bytes. No WebSocket import anywhere in the file. If you wanted to run this protocol logic on Cloudflare Workers, the encoding and decoding would work unchanged; you'd only rewrite the transport layer that feeds bytes in and ships bytes out.

## Why Rust gets the extra win

TypeScript can follow the sans-IO pattern. Factor your protocol into pure functions, write runtime-specific adapters. The architecture works. But you still end up maintaining four adapter codebases in four slightly different flavors of TypeScript, each importing different platform APIs.

Rust compiles to Wasm, and Wasm is a standardized compilation target with a well-defined I/O boundary. One compiled artifact, one test suite, two deployment targets. The sans-IO core doesn't just avoid I/O conceptually; it avoids it at the binary level. The Wasm module literally cannot access the network because it has no network imports. The host environment (Axum or Workers) bridges that gap.

The lesson isn't "rewrite everything in Rust." It's that portability comes from not doing I/O, not from running everywhere. Sans-IO is the architectural pattern. Wasm is the mechanism that makes Rust's version of it compile once instead of four times.

---

_Sources:_

- [y-sweet](https://github.com/jamsocket/y-sweet): sans-IO Rust sync server with Axum and Cloudflare Workers adapters
- [sans-io.readthedocs.io](https://sans-io.readthedocs.io/how-to-sans-io.html): the original pattern documentation
- [Firezone: Sans-IO in Rust](https://www.firezone.dev/blog/sans-io): practical application of sans-IO in production Rust
- [`packages/epicenter/src/server/sync/protocol.ts`](../packages/epicenter/src/server/sync/protocol.ts): sans-IO protocol layer in this codebase
