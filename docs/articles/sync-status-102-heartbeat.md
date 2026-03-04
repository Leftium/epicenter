# MESSAGE_SYNC_STATUS: One Probe, Two Problems Solved

The y-websocket protocol defines four message types: SYNC, AWARENESS, AUTH, QUERY_AWARENESS. Standard implementations stop there and assume an open socket means sync is happening. That assumption breaks two ways, and we added a fifth message type to fix both.

The first break is dead connections. WebSocket connections can zombie: the TCP layer breaks silently, no FIN or RST arrives, and the client sits in a "connected" state while edits go nowhere. This is common on mobile networks and NAT traversal. The server has a 30-second ping/pong interval to catch it from its side, but the client has no equivalent. Without client-side detection, you can be stuck for minutes.

The second break is save feedback. You know when your local doc has changes. You don't know when the server received them. A "Saving..." / "Saved" indicator is a baseline expectation in collaborative tools, and y-websocket gives you nothing to build it from.

`MESSAGE_SYNC_STATUS = 102` solves both. The wire format is three varints:

```
[varuint: 102][varuint: payload length][varuint: localVersion]
```

The client sends this probe after each local edit and on a 2-second idle timer when no messages have arrived. The server echoes the raw payload back without parsing it. That's the entire server implementation: receive 102, echo it. Zero state, no version tracking. Any relay that can forward binary frames can support it.

The probe does double duty. The echo proves the connection is alive and confirms the server received the encoded `localVersion`. When the echoed version matches `localVersion`, `hasLocalChanges` clears and the UI shows "Saved." If no echo arrives within 3 seconds of a probe, the client closes and reconnects.

[Y-sweet](https://github.com/jamsocket/y-sweet) was one of the first Yjs backends to take connection death seriously. Their client explicitly tracks sync status and disconnects when a heartbeat goes unanswered. Looking at their approach made it clear: the protocol gives you the primitives; you have to build the detection yourself.

The `serverSupports102` flag makes this non-breaking. It starts false. The first time a 102 echo arrives, it flips to true and the connection timeout arms from then on. Against a standard y-websocket server that ignores 102, the flag never flips, the timeout never fires, and the client degrades gracefully. The save status stays at "Saving..." rather than "Saved," which is honest: the server didn't ack.

Two seconds is aggressive for a heartbeat. For a sync tool where users expect "Saved" to appear quickly, it's right. The two purposes share exactly the same wire format and code path. You get both for free.
