# API

The hub server. Handles authentication, real-time sync, and AI inference—everything that needs a single authority across devices.

Runs on Cloudflare Workers with Durable Objects. Each user gets dedicated Durable Objects for their workspaces and documents, providing per-user isolation with WebSocket-based real-time sync.

## Why a hub exists

Local-first doesn't mean no server. It means your data lives on your machine and you aren't dependent on a cloud service to function. But some operations genuinely need a single authority: user identity, API key storage, AI proxying. Trying to make every device a peer for these operations led to three failed attempts at distributed key management before we split into hub (central authority) and local (device-side execution).

The hub handles auth, sync relay, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Encryption and trust model

Workspace data synced through the hub is encrypted at rest with AES-256-GCM. The Durable Objects that store Yjs documents see CRDT structure (key names, timestamps for conflict resolution) but not values. A storage-layer dump yields noise.

The server holds a per-user encryption key. When you authenticate, the key decrypts your data for features that need it: search, AI, password recovery. The server can read your data. That's the design—zero-knowledge encryption would prevent every server-side feature from working.

| Deployment | Key location | Who can decrypt | Features |
|---|---|---|---|
| Epicenter Cloud | Our infrastructure | Epicenter | All: search, AI, password reset, device migration |
| Self-hosted | Your infrastructure | Only you | Identical |

Self-hosting makes this functionally zero-knowledge. The encryption key sits on a machine you control. Same binary, same API surface—the deployment is the trust boundary.

### Why not zero-knowledge?

Zero-knowledge means the server can't read your data. The cost: password recovery doesn't work (the server can't re-derive your key), search doesn't work (the server can't index ciphertext), AI doesn't work (the server can't read your notes to summarize them), and device migration requires a key transfer ceremony.

PGP has been trying to make key management practical for thirty years. Signal works because messaging is one-dimensional—the server is a relay that never processes content. Most apps aren't relays. Epicenter needs to search documents, run AI against notes, and let users reset passwords without losing everything.

For the full argument:

- [Why E2E Encryption Keeps Failing](/docs/articles/why-e2e-encryption-keeps-failing.md)—PGP, Signal, and the structural problem
- [Let the Server Handle Encryption](/docs/articles/let-the-server-handle-encryption.md)—the pragmatic alternative
- [If You Don't Trust the Server, Become the Server](/docs/articles/if-you-dont-trust-the-server-become-the-server.md)—self-hosting as the clean answer
- [Encrypted Workspace Storage spec](/specs/20260213T005300-encrypted-workspace-storage.md)—implementation details

## Architecture

```
Cloudflare Workers
├── Hono app (src/app.ts)
│   ├── /auth/*          Better Auth (email/password, Google OAuth, OAuth provider)
│   ├── /ai/chat         AI streaming (OpenAI, Anthropic via @tanstack/ai)
│   ├── /workspaces/:id  Yjs sync (WebSocket upgrade or HTTP)
│   └── /documents/:id   Yjs sync with snapshots
│
├── WorkspaceRoom (Durable Object, SQLite-backed)
│   └── Per-user Yjs document for workspace data (settings, transcripts, notes)
│
└── DocumentRoom (Durable Object, SQLite-backed)
    └── Per-user Yjs document for long-form content, with snapshot history
```

API keys for AI providers are environment secrets (`wrangler secret put`). They never leave the hub—the client sends a session token, the hub validates it and swaps in the real key before forwarding to the provider.

## Development

```bash
bun dev:local        # Local dev server (uses local Postgres)
bun dev:remote       # Dev with remote secrets via Infisical
bun deploy           # Deploy to Cloudflare Workers
bun run typecheck    # Type check
bun test             # Run tests
```

### Database

```bash
bun run auth:generate    # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local    # Push schema to local Postgres
bun run db:push:remote   # Push schema to remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio
```

See `wrangler.jsonc` for Durable Object bindings, KV namespaces, and Hyperdrive (Postgres connection pool) configuration.
