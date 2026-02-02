# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [Network Topology](./network-topology.md) | Node types (client/server), connection rules, example topologies |
| [Device Identity](./device-identity.md)   | How devices identify themselves, server URLs, registry entries   |
| [Action Dispatch](./action-dispatch.md)   | Cross-device action invocation via YJS command mailbox           |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model    |

## Quick Reference

### Node Types

| Type   | Runtime  | Can Accept Connections | Can Serve Blobs |
| ------ | -------- | ---------------------- | --------------- |
| Client | Browser  | No                     | No              |
| Server | Bun/Node | Yes                    | Yes             |

### Connection Rules

```
Client ──► Server     ✅  (WebSocket, HTTP)
Client ──► Client     ✅  (via YJS action dispatch, not direct connection)
Server ──► Server     ✅  (WebSocket)
Server ──► Client     ✅  (via YJS action dispatch, not direct connection)
```

Note: Direct connections are only possible **to** servers. However, any device can invoke actions on any other device via [action dispatch](./action-dispatch.md) through the shared Y.Doc.

### Typical Setup

```
         ┌─────────┐           ┌─────────┐
         │LAPTOP A │           │LAPTOP B │
         │ Browser │           │ Browser │
         │    ▼    │           │    ▼    │
         │ Server ◄├───────────┼► Server │     ┌────────┐
         └────▲────┘           └────▲────┘     │ PHONE  │
              │                     │          │Browser │
              └─────────────────────┴──────────┴───┘
```

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
