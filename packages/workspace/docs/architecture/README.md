# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [Network Topology](./network-topology.md) | Node types (client/server), connection rules, example topologies |
| [Node Identity](./node-identity.md)   | How nodes identify themselves: the install-stable `nodeId`, relay routing, presence |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model    |

## Quick Reference

> **Topology note:** Epicenter uses a two-tier architecture. Browsers connect to the remote server (`apps/api`) which handles auth (Better Auth), AI streaming (`/ai/chat`), and a Yjs relay. A local sidecar tier was previously planned but has been removed. See [Network Topology](./network-topology.md) for the full picture.

### Node Types

| Type          | Runtime  | Can Accept Connections | Can Serve Blobs | Notes                                           |
| ------------- | -------- | ---------------------- | --------------- | ----------------------------------------------- |
| Client (SPA)  | Browser  | No                     | No              | Data + AI → remote server                       |
| Remote Server | Bun/Node | Yes                    | No              | `apps/api`; auth, AI proxy, Yjs relay |

### Connection Rules

```
Client ──► Remote Server  ✅  (WebSocket, HTTP: data sync, presence, AI, auth)
Client ──► Device route    ✅  (via the relay floor's exposed MCP routes, not a direct connection)
Server ──► Server         ✅  (WebSocket)
```

Note: Direct connections are only possible **to** servers. Cross-device capability does not need one: a device opts a named route in over the relay floor (`relay: 'exposed'`, ADR-0073) and advertises it in presence, and a signed-in client auto-mounts every advertised route of its own fleet as an MCP tool catalog, reaching it over the shared relay channel rather than a direct connection.

### Typical Setup

```
         ┌─────────┐           ┌─────────┐          ┌────────┐
         │LAPTOP A │           │LAPTOP B │          │ PHONE  │
         │ Browser │           │ Browser │          │Browser │
         └────┬────┘           └────┬────┘          └───┬────┘
              │                     │                   │
              └─────────────────────┼───────────────────┘
                                    │
                              ┌─────▼─────┐
                              │  Remote   │
                              │  Server   │
                              └───────────┘
```

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
