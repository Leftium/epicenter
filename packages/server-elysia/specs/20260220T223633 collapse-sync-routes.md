# Collapse Sync Plugin Routes

**Date**: 2026-02-20
**Status**: Draft
**Author**: AI-assisted

## Overview

Simplify the sync plugin's route structure from four routes with redundant path segments (`/:room/sync`, `/:room/doc`) to three routes on the canonical resource path (`/:room`). One resource, one URL.

## Motivation

### Current State

The sync plugin registers four routes:

```
GET  /              → list rooms
WS   /:room/sync    → real-time y-websocket protocol
GET  /:room/doc     → document state as binary Yjs update
POST /:room/doc     → apply binary Yjs update
```

When mounted at `/rooms` prefix (the default), the actual URLs are:

```
GET  /rooms/
WS   /rooms/{id}/sync
GET  /rooms/{id}/doc
POST /rooms/{id}/doc
```

This creates problems:

1. **Redundant path segments**: `/rooms/{id}/doc` says "the doc of the room" but the room IS the document. There's no other sub-resource. It's like `/users/{id}/user`.
2. **Transport in the URL**: `/rooms/{id}/sync` names the protocol, not a resource. REST says URLs identify resources, not how you talk to them.
3. **Same resource, two URLs**: The room has two different identifiers depending on whether you're using HTTP or WebSocket, violating the uniform interface constraint.

### Desired State

```
GET  /              → list rooms
WS   /:room         → real-time y-websocket protocol
GET  /:room         → document state as binary Yjs update
POST /:room         → apply binary Yjs update
```

Mounted at `/rooms`:

```
GET  /rooms/
WS   /rooms/{id}
GET  /rooms/{id}
POST /rooms/{id}
```

One resource, one URL. WebSocket upgrade is distinguished by the `Upgrade: websocket` header per RFC 6455 -- it doesn't collide with HTTP GET/POST.

## Design Decisions

| Decision                           | Choice       | Rationale                                                                                                                          |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Collapse `/:room/doc` to `/:room`  | Yes          | The room IS the document. No sub-resource exists.                                                                                  |
| Collapse `/:room/sync` to `/:room` | Yes          | WS upgrade is a protocol-level concern, not a resource. RFC 6455 distinguishes via `Upgrade` header.                               |
| Keep `GET /` for room listing      | Yes          | Collection resource at the root is standard REST. No change needed.                                                                |
| Elysia WS + HTTP on same path      | Verify first | Need to confirm Elysia/Bun can route both `.ws('/:room')` and `.get('/:room')` without collision. This is the only technical risk. |

## Implementation Plan

### Phase 0: Verify Elysia Can Handle WS + HTTP on Same Path

- [ ] **0.1** Write a minimal Elysia test that registers `.ws('/:room')` and `.get('/:room')` on the same path, confirm HTTP GET and WS upgrade both work without collision.

If this fails, fallback plan: keep WS at `/:room` and HTTP at `/:room` but with different Elysia route registration order, or worst case keep `/:room/ws` (transport label, not resource duplication).

### Phase 1: Update the Plugin Route Definitions

- [ ] **1.1** In `packages/server/src/sync/plugin.ts`: change `.ws('/:room/sync', ...)` to `.ws('/:room', ...)`
- [ ] **1.2** In `packages/server/src/sync/plugin.ts`: change `.get('/:room/doc', ...)` to `.get('/:room', ...)`
- [ ] **1.3** In `packages/server/src/sync/plugin.ts`: change `.post('/:room/doc', ...)` to `.post('/:room', ...)`
- [ ] **1.4** Update the JSDoc route table in `createSyncPlugin` to reflect new routes

### Phase 2: Update Tests

- [ ] **2.1** In `packages/server/src/sync/plugin.test.ts`: update `wsUrl()` helper from `/rooms/${room}/sync` to `/rooms/${room}`
- [ ] **2.2** In `packages/server/src/sync/plugin.test.ts`: update all `httpUrl('/rooms/${room}/doc')` calls to `httpUrl('/rooms/${room}')`
- [ ] **2.3** In `packages/server/src/sync/plugin.test.ts`: update `startIntegratedTestServer` `wsUrl()` from `/${room}/sync` to `/${room}`
- [ ] **2.4** In `packages/server/src/sync/plugin.test.ts`: update integrated mode `httpUrl('/${room}/doc')` to `httpUrl('/${room}')`
- [ ] **2.5** Run tests, confirm all pass

### Phase 3: Update Server + Standalone Wrappers

- [ ] **3.1** In `packages/server/src/server.ts`: update JSDoc URL references
- [ ] **3.2** In `packages/server/src/sync/server.ts`: update JSDoc URL references
- [ ] **3.3** In `packages/server/src/start-hub.ts` and `packages/server/src/start-local.ts`: update console.log URL and JSDoc comment

### Phase 4: Update Client-Side Consumers

- [ ] **4.1** In `packages/epicenter/src/extensions/sync.ts`: update all `url` examples from `/rooms/{id}/sync` to `/rooms/{id}`
- [ ] **4.2** In `packages/epicenter/src/extensions/sync/web.ts`: update URL examples
- [ ] **4.3** In `packages/epicenter/src/extensions/sync/desktop.ts`: update URL examples
- [ ] **4.4** In `packages/epicenter/src/extensions/sync.test.ts`: update all URL strings from `/rooms/{id}/sync` to `/rooms/{id}`
- [ ] **4.5** In `packages/sync/src/provider.ts`: update JSDoc URL examples
- [ ] **4.6** In `apps/tab-manager/src/entrypoints/background.ts`: update URL string
- [ ] **4.7** In `apps/tab-manager/src/lib/workspace-popup.ts`: update URL string

### Phase 5: Update Documentation

- [ ] **5.1** In `packages/server/README.md`: update all route tables, URL examples, URL hierarchy
- [ ] **5.2** In `packages/sync/README.md`: update URL examples and relationship diagram
- [ ] **5.3** In `packages/epicenter/README.md`: update sync URL examples throughout

### Phase 6: Final Verification

- [ ] **6.1** Run full test suite for `@epicenter/server`
- [ ] **6.2** Grep for any remaining `/sync` or `/doc` path references that were missed
- [ ] **6.3** Run build to confirm no breakage

## Edge Cases

### Elysia Route Collision

1. Register both `.ws('/:room')` and `.get('/:room')` on same Elysia instance
2. Elysia may not support this natively
3. If collision: fallback to `.ws('/:room/ws')` -- still better than `/sync` since `ws` describes transport, and the HTTP routes would still be on `/:room`

### Reverse Proxy Confusion

1. Some reverse proxies (nginx, Cloudflare) may need explicit WebSocket upgrade configuration
2. This is already the case with `/sync` -- moving to `/:room` doesn't change the requirement
3. No new edge case introduced

## Open Questions

1. **Does Elysia support WS and HTTP GET on the same path?**
   - This is the gating question. Phase 0 answers it.
   - **Recommendation**: Spike it first. If it fails, fall back to `/:room/ws` for WS only.

## Success Criteria

- [ ] All four routes work at their new paths
- [ ] All existing tests pass with updated URLs
- [ ] No remaining references to `/:room/sync` or `/:room/doc` in codebase
- [ ] JSDoc and README documentation reflects new routes

## References

- `packages/server/src/sync/plugin.ts` -- route definitions (the core change)
- `packages/server/src/sync/plugin.test.ts` -- integration tests (largest file to update)
- `packages/server/src/sync/server.ts` -- standalone server wrapper
- `packages/server/src/server.ts` -- full server compositor
- `packages/server/src/start-hub.ts` -- Hub server CLI entry point
- `packages/server/src/start-local.ts` -- Local server CLI entry point
- `packages/epicenter/src/extensions/sync.ts` -- client-side sync extension
- `packages/epicenter/src/extensions/sync.test.ts` -- client-side tests
- `packages/sync/src/provider.ts` -- raw sync provider
- `apps/tab-manager/src/entrypoints/background.ts` -- app consumer
- `apps/tab-manager/src/lib/workspace-popup.ts` -- app consumer
- `packages/server/README.md` -- server docs
- `packages/sync/README.md` -- sync client docs
- `packages/epicenter/README.md` -- epicenter docs
