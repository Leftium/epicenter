# y-sweet's MESSAGE_SYNC_STATUS: Application-Layer TCP Sequence Numbers

> **Note**: `@epicenter/server` and `@epicenter/sync` implement this protocol. See `packages/server/src/sync/protocol.ts` for the server-side encoding and `packages/sync/src/provider.ts` for the client-side implementation. The article below describes y-sweet's original implementation, which inspired ours.

Yjs's sync protocol is fire-and-forget — you serialize your local changes into a binary update, shove it into the WebSocket, and hope for the best. There's no built-in acknowledgment. The problem is that WebSockets can silently die (the TCP connection hangs, the server crashes, your laptop switches from WiFi to cellular) and your application has no way to know that the last 30 seconds of typing never left the machine. The local version counter fixes this cheaply: every time you make a local edit, you bump an integer and send it alongside. The server echoes it back. Now you can compare two numbers — `ackedVersion` vs `localVersion` — and know instantly whether your changes have reached the server. This gives you three things you couldn't have otherwise: (1) a reliable `hasLocalChanges` flag so you can show a "syncing..." indicator or block the `beforeunload` with "you have unsaved changes," (2) a liveness probe that doubles as the heartbeat — if the echo doesn't come back in 3 seconds, you know the connection is dead and can reconnect *before* the user notices, and (3) you get all of this without touching the Yjs document state at all — the server doesn't even parse the version number, it just mirrors bytes, so it's zero-cost and can never corrupt sync state. It's essentially the same idea as TCP sequence numbers but at the application layer: tag your outbound data with a monotonic counter, wait for the other side to confirm it, and if confirmation stops arriving, assume the pipe is broken.

---

## Wire Format

The message uses tag 102, well outside the standard Yjs protocol range (0–3). Unknown tags are simply ignored by any Yjs implementation that doesn't understand them, making this a safe, non-breaking extension.

```
[varuint: 102] [varuint: payload length] [varuint: localVersion]
```

On the client ([`provider.ts`](https://github.com/jamsocket/y-sweet/blob/main/js-pkg/client/src/provider.ts)):

```typescript
const MESSAGE_SYNC_STATUS = 102
```

On the server ([`doc_connection.rs`](https://github.com/jamsocket/y-sweet/blob/main/crates/y-sweet-core/src/doc_connection.rs)):

```rust
const SYNC_STATUS_MESSAGE: u8 = 102;
```

---

## The Protocol Flow

### Client-side state

```typescript
private localVersion: number = 0     // bumped on every local edit
private ackedVersion: number = -1    // last version the server echoed back

get hasLocalChanges() {
    return this.ackedVersion !== this.localVersion
}
```

### Step by step

**1. Local edit** — The client sends the standard Yjs sync update (tag 0), bumps `localVersion++`, and immediately sends `MESSAGE_SYNC_STATUS` with that version number.

**2. Server echoes** — The Rust server does a trivial one-line echo. No parsing, no processing, just mirror the bytes:

```rust
Message::Custom(SYNC_STATUS_MESSAGE, data) => {
    Ok(Some(Message::Custom(SYNC_STATUS_MESSAGE, data)))
}
```

**3. Client receives the echo** — Extracts the version number. If `ackedVersion == localVersion`, all local changes have reached the server. This powers the `hasLocalChanges` property, the `beforeunload` warning, and the `EVENT_LOCAL_CHANGES` event.

---

## Heartbeat Timing

Even without local edits, the client proactively pings every 2 seconds of quiet:

| Event | What happens |
|-------|-------------|
| No messages received for **2 seconds** | Client sends `MESSAGE_SYNC_STATUS`, arms a 3-second timeout |
| Server responds (anything) within **3 seconds** | Timeout cleared, heartbeat reset |
| **Nothing** comes back within 3 seconds | WebSocket closed, reconnect with backoff |

Worst-case dead connection detection: **5 seconds** (2s quiet + 3s timeout).

The browser `offline` event bypasses the 2s wait and triggers an immediate probe.

---

## Two Layers of Keepalive

y-sweet runs two independent keepalive mechanisms:

| Layer | Direction | Interval | Timeout | Purpose |
|-------|-----------|----------|---------|---------|
| **Application** (MESSAGE_SYNC_STATUS) | Client → Server → Client | 2s idle | 3s | Fast detection + change tracking |
| **WebSocket ping/pong** | Server → Client → Server | 20s | 40s | Catches dead TCP connections |

---

## Backward Compatibility

The client doesn't arm the 3-second reconnect timeout until it has received at least one sync status response on the current connection. If connected to an older server that doesn't understand tag 102, the heartbeat messages are sent but silently ignored, and the reconnect logic never triggers false positives.

---

_Primary sources:_

- [y-sweet provider.ts](https://github.com/jamsocket/y-sweet/blob/main/js-pkg/client/src/provider.ts) — Client-side MESSAGE_SYNC_STATUS implementation
- [y-sweet doc_connection.rs](https://github.com/jamsocket/y-sweet/blob/main/crates/y-sweet-core/src/doc_connection.rs) — Server-side echo handler
- [y-sweet sync/mod.rs](https://github.com/jamsocket/y-sweet/blob/main/crates/y-sweet-core/src/sync/mod.rs) — Message encoding/decoding with Custom variant
- [Yjs](https://github.com/yjs/yjs) — The CRDT framework this extends
