# Workspace Apps: Install, Mount, Run

**Date**: 2026-02-25
**Status**: Draft
**Author**: AI-assisted

## Overview

Turn each workspace into a self-contained app that can be installed from a registry, mounted into a single Elysia orchestrator process, accessed from a unified Svelte shell, and optionally run standalone or synced against a remote hosted version.

The core insight: `epicenter.config.ts` is a **universal contract** — a workspace definition (schema + actions) that works identically whether mounted in an orchestrator, run standalone on its own port, or imported directly by a browser SPA. Every namespace in the filesystem is its own app. You can download and run 20 of them locally in one process, run any individually, or import the config in a client-side app that operates on its own Y.Doc and syncs via WebSocket. Hub sync keeps instances in sync regardless of where they run.

**Terminology**: `createWorkspace()` returns a `WorkspaceClientBuilder` — an object that IS a `WorkspaceClient` (Y.Doc, tables, kv, awareness) plus chainable builder methods (`.withExtension()`, `.withDocumentExtension()`, `.withActions()`). The builder uses immutable state — each `.withExtension()` returns a new builder, enabling builder branching (multiple chains from the same base). `.withActions()` is terminal, producing a `WorkspaceClientWithActions`.

**The config exports the builder, not the terminal client.** The `epicenter.config.ts` default export is a `WorkspaceClientBuilder` — the result of `createWorkspace()` without `.withExtension()` or `.withActions()` chained. This is the **data contract**: schema only. Each runtime (browser SPA, Bun sidecar, standalone hosted workspace) imports the builder and chains its own extensions and actions as appropriate. Extensions and actions are **not** part of the config — they are attached per-runtime, keeping the config portable and allowing different runtimes to expose different capabilities.

## Motivation

### Current State

Workspaces are hardcoded TypeScript templates compiled into the desktop app (`apps/epicenter/src/lib/templates/`). The server loads all workspace clients into a single `createLocalServer()` call with parameterized routes:

```typescript
// packages/server/src/local.ts
const app = new Elysia()
  .use(new Elysia({ prefix: '/workspaces' })
    .use(createWorkspacePlugin(clients)))  // ALL clients, one process
```

The CLI discovers workspaces by scanning directories for `epicenter.config.ts` files and dynamically importing them:

```typescript
// packages/cli/src/discovery.ts
const module = await import(Bun.pathToFileURL(configPath).href);
const client = module.default; // WorkspaceClientWithActions
```

This creates problems:

1. **No runtime installation**: Adding a workspace means editing source code and rebuilding the app.
2. **No isolation**: All workspaces share the same Elysia route tree, same process, same dependency context. A workspace can't bring its own dependencies.
3. **Two paradigms exist**: Desktop uses compiled templates, CLI uses dynamic TypeScript imports. They should converge.
4. **No standalone mode**: A workspace can't run on its own as a web app outside the Epicenter shell.

### Desired State

Each workspace is a directory with an `epicenter.config.ts` that can be:
- **Installed** from a jsrepo registry via the CLI
- **Mounted** into the orchestrator as an isolated Elysia sub-app
- **Browsed** in the Svelte shell alongside other workspaces
- **Run standalone** on its own port as a plain web app
- **Synced remotely** — a hosted version at `myapp.com` can share data with the local instance via Yjs hub relay

## Research Findings

### Elysia Composition: `mount()` vs `.use()` vs Reverse Proxy

Elysia provides two in-process composition mechanisms, plus external proxying:

| Mechanism | How it works | HTTP | WebSocket | Process |
|-----------|-------------|------|-----------|---------|
| `.use()` | Merges plugin into parent. Shares lifecycle hooks (scoped), decorators, store. | Yes | Yes | Same |
| `.mount(path, handler.fetch)` | Passes raw `Request` to a WinterCG `fetch` handler. Strips prefix. Fully isolated. | Yes | **No** | Same |
| `.mount(path, elysiaInstance)` | **Extracts `.fetch` handler** — same behavior as raw handler. Types NOT preserved, OpenAPI hidden, WebSocket broken. | Yes | **No** | Same |
| Reverse proxy | Manual `fetch()` forwarding to another port | Yes | Manual relay only | Separate |

**Critical nuance**: `.mount()` **always extracts `.fetch`** regardless of what you pass it. Passing an Elysia instance is NOT the same as calling `.use()`:

```typescript
// RAW HANDLER — opaque, no types, no OpenAPI, no WebSocket
orchestrator.mount('/entries', entriesApp.fetch);

// ELYSIA INSTANCE — also extracts .fetch internally. Same result as above.
// Does NOT auto-resolve via .use(). Types, OpenAPI, WebSocket all lost.
orchestrator.mount('/entries', entriesApp);

// CORRECT approach for first-party workspaces:
orchestrator.use(new Elysia({ prefix: '/entries' }).use(entriesApp));
```

The official docs claim `.mount(path, elysiaInstance)` auto-resolves via `.use()`, but source code analysis shows it extracts `.fetch` regardless. Verified via DeepWiki source analysis: routes are registered with `detail: { hide: true }` and WebSocket routes are inaccessible.

| Aspect | `.use(plugin)` | `.mount(path, anything)` |
|--------|---------------|--------------------------|
| Type inference (Eden) | Full | **None** |
| OpenAPI docs | Included | **Hidden** (`detail.hide = true`) |
| Lifecycle hooks | Merged (scoped) | **Isolated** |
| WebSocket | Yes | **No** |
| Prefix stripping | Via `{ prefix }` option | Automatic |
| Runtime overhead | Near zero (AOT) | New `Request` per call |
| Non-Elysia frameworks | No | **Yes** (Hono, etc.) |

**Key finding**: WebSocket proxying in Bun is broken. There is a known issue (`oven-sh/bun#10441`) where Bun's HTTP handling emits a `response` event instead of `upgrade`, breaking `node-http-proxy` and similar libraries. Manual WebSocket relay is possible but fragile and adds latency to Yjs sync messages.

**Implication**: For first-party workspaces, `.use()` with `{ prefix }` is the clear winner — preserves types, OpenAPI, WebSocket, with zero runtime overhead. `.mount(path, handler.fetch)` becomes relevant only when mounting untrusted third-party code or non-Elysia frameworks. The orchestrator should own the sync relay (WebSocket) centrally regardless of which composition mechanism is used for HTTP routes.

### jsrepo as Distribution Mechanism

jsrepo distributes source code blocks from GitHub-backed registries.

| Capability | Support | Notes |
|-----------|---------|-------|
| Multi-file directories | Yes | `subdirectory: true` preserves tree structure |
| Arbitrary file types | Yes | `.ts`, `.svelte`, `.json`, anything |
| npm dependency detection | Yes | Reads registry's `package.json` for versions |
| Per-app `package.json` | **No** | Installs deps into consumer's root, doesn't copy `package.json` |
| Programmatic API | Yes | Exported from `dist/api/index.js`. File writing is NOT included — we write files ourselves via Bun. |
| Import rewriting | Yes (automatic, CLI only) | CLI rewrites imports; programmatic API fetches raw content without transformation |

**Key finding**: jsrepo's model is "copy source into your project." It does not natively support isolated per-workspace `package.json` files. The `package.json` in the registry is read for dependency versions but not copied to the consumer.

**Programmatic API surface** (confirmed from `dist/api/index.js`):
```typescript
import { registry } from 'jsrepo/api';

registry.getProviderState(url, options?)     // → Result<RegistryProviderState, string>
registry.fetchManifest(providerState)        // → Result<RegistryManifest, string>
registry.fetchManifests(providerStates[], options?) // → Result<RegistryManifest[], ...>
registry.fetchRaw(providerState, filePath)   // → Result<string, string>  (raw file content)
registry.getRemoteBlocks(manifests)          // → Map<string, RemoteBlock>
registry.selectProvider(url)                // → RegistryProvider | undefined
registry.jsrepo.parse(url, options)         // → parsed URL components
```

File writing is not in the API — we use Bun's file APIs directly after fetching raw content. This means **no import rewriting happens** when using the programmatic API, solving the mangling concern without any post-processing.

**Implication**: We should use jsrepo for source distribution but handle `package.json` generation and `bun install` ourselves. The workspace directory layout includes a `package.json` that jsrepo doesn't manage — either we template it during install, or the `epicenter.config.ts` file is self-sufficient (imports only from `@epicenter/workspace` which is already installed globally).

### Better Auth Across Services

Better Auth's JWT plugin issues tokens validated via a JWKS endpoint. Any service can validate locally:

```typescript
const { payload } = await jwtVerify(token, createRemoteJWKSet(
  new URL('https://hub.example.com/api/auth/jwks')
));
```

**Implication**: The orchestrator validates auth once. Mounted workspace sub-apps trust the orchestrator's process boundary — no per-workspace auth needed.

### Yjs Sync as the Shared Data Layer

The existing sync plugin (`packages/server/src/sync/plugin.ts`) is a Y.Doc WebSocket relay. Any client — local WebView, remote web app, CLI — connects to a room and syncs via the standard y-websocket protocol.

**Key finding**: This is already the mechanism for remote data sharing. A hosted version of a workspace at `myapp.com` and the local Epicenter instance can both connect to the same hub room. Yjs handles the merge. No special plumbing needed beyond what exists.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage location | `~/.epicenter/` (dotfile in `$HOME`) | Developer-friendly: tab-completable (`~/.ep<tab>`), no spaces in path (unlike `~/Library/Application Support/`), cross-platform (works on macOS, Linux, WSL), follows conventions of `.cargo/`, `.bun/`, `.docker/`. Non-developer users never interact with the filesystem directly — the Tauri app and CLI are the interfaces. **Alternatives considered**: `~/Library/Application Support/Epicenter/` (Apple-sanctioned, Time Machine-backed, but path has spaces, macOS-only, annoying to `cd` into), `~/Documents/Epicenter/` (user-visible, iCloud-synced, but mixes app internals like `node_modules/` and `workspace.yjs` with user content). **Backup implication**: `~/.epicenter/` is excluded from iCloud sync by default and may be skipped by some backup tools. This is acceptable because: (1) the Y.Doc can be reconstructed from hub sync, (2) extensions project user-visible data to backed-up locations like `~/Documents/`, (3) Time Machine does cover dotfiles. |
| Discovery model | Centralized directory + symlinks for dev workspaces | Single `readdir()` scan — no config registry to corrupt or get stale. Installed workspaces live directly in `~/.epicenter/workspaces/`. Developer-authored workspaces (in git repos elsewhere) are symlinked in via `epicenter add <path>`. Avoids the "stale paths in config.json" problem of the distributed model. |
| Filesystem projections | `.withExtension()` on workspace config | Workspaces may need to materialize Y.Doc data to arbitrary filesystem locations (Markdown files, JSON exports, etc.). Extensions are reactive side effects that subscribe to Y.Doc changes and write to a target path. This keeps the core contract clean (schema + actions) and makes materialization opt-in. The workspace directory stays centralized; extensions project *outward*. **This is the key enabler for the `~/.epicenter/` storage decision**: the internal data (Y.Doc, config, deps) lives in a hidden developer-friendly location, while extensions project user-visible output (Markdown, JSON, etc.) to wherever the user wants (`~/Documents/`, `~/notes/`, Obsidian vaults). The workspace doesn't need to *be* in the output directory to *write* to it. |
| Composition mechanism | `.use()` with `{ prefix }` for first-party workspaces, centralized sync relay for WS | `.use()` preserves Eden Treaty types, OpenAPI docs, and WebSocket support. `.mount(path, handler.fetch)` reserved for future untrusted third-party code where lifecycle isolation is needed. See Research Findings for the critical nuance between `.mount(path, instance)` (auto `.use()`) vs `.mount(path, instance.handle)` (true isolation). |
| Process model | Single process | Avoids port management, WebSocket relay, CORS across origins. `mount()` provides logical isolation. |
| Distribution | jsrepo programmatic API for source + custom install step for deps | Use `registry.getProviderState()`, `registry.fetchManifest()`, `registry.getRemoteBlocks()`, `registry.fetchRaw()` from `jsrepo/api`. Write files ourselves via Bun (no file-writing in the API). We handle `package.json` generation and `bun install` since jsrepo doesn't support per-app isolation. Programmatic API skips CLI's import rewriting, so `@epicenter/workspace` imports arrive unmodified. |
| CLI role | Package manager + process launcher | `epicenter install`, `epicenter serve`, `epicenter add`, `epicenter <workspace> <command>`. Not a persistent daemon. |
| Standalone mode | Each workspace can also run via `createLocalServer({ clients: [client] })` | The same `epicenter.config.ts` works mounted or standalone — isomorphic by design. |
| Config portability | `epicenter.config.ts` default export is the builder — no extensions, no actions | The config is the data contract (schema only). Each runtime chains its own extensions and actions. Enables browser SPA to import the config for local-first Y.Doc operations, while the server chains FS extensions and server-only actions. |
| Remote sync | Via hub relay, not a new mechanism | Hosted apps and local apps connect to the same Yjs room on the hub. Already works. |
| Auth boundary | Orchestrator validates; mounted apps trust process | Better Auth JWT validated at the edge. No per-workspace auth layer. |

## Two Runtime Modes

Every workspace has the same storage format on disk. The only question is **how you run it**: mounted in the orchestrator alongside other workspaces, or standalone on its own port. Sync via a Yjs hub is orthogonal — any workspace in either mode can optionally connect to a hub.

### Orchestrator-Mounted

The default. The orchestrator scans `~/.epicenter/workspaces/`, imports each `epicenter.config.ts`, and `.use()`s it into a single Elysia server. All workspaces share one process, one port, one sync relay.

```
~/.epicenter/workspaces/epicenter.entries/
├── epicenter.config.ts    # Full source: schema + actions + handlers
├── package.json           # Dependencies (if any)
├── node_modules/          # bun install'd
└── data/
    └── workspace.yjs      # Local Y.Doc (source of truth)
```

**Data flow**: Browser → Elysia orchestrator → Y.Doc in memory → persisted to `workspace.yjs`
**Sync**: Optional. Start the orchestrator with `--hub <url>` to share data with other instances.

This is the "app store" experience. `epicenter install @epicenter/entries` downloads the source, installs deps, and the orchestrator picks it up on next start. You could install 20 apps this way and they all mount into the same process under their own route prefix.

### Standalone

Any workspace can run independently on its own port:

```bash
epicenter run epicenter.entries --port 4000
epicenter run epicenter.entries --port 4000 --hub wss://hub.example.com
```

The storage format is identical to orchestrator-mounted — same directory, same files. The only difference is the process model: one workspace, one port, one server.

This produces an identical API surface to being mounted in the orchestrator — same routes, same sync, same Eden Treaty types. The workspace doesn't know or care whether it's mounted or standalone.

**Use cases**:
- Development: iterate on a workspace without starting the full orchestrator
- Hosting: deploy a single workspace as a web service
- Embedding: mount the workspace into someone else's Elysia app via `.use()` or `.mount()`

### How Sync Composes Instances

The interesting scenario: the same workspace running in multiple places, all syncing through a hub.

```
Laptop A:  epicenter.entries (orchestrator, --hub wss://hub.example.com)
Laptop B:  epicenter.entries (orchestrator, --hub wss://hub.example.com)
Server:    epicenter.entries (standalone, deployed at entries.example.com, --hub wss://hub.example.com)
```

All three have the full workspace installed. All three run it locally. All three connect to the same Yjs hub room. CRDTs ensure they converge regardless of edit order or network partitions. There's no special "remote" mode — it's just multiple instances of the same workspace syncing via the mechanism Yjs already provides.

## Architecture

### The Orchestrator

```
┌──────────────────────────────────────────────────────────────┐
│  Elysia Orchestrator (single process, one port)              │
│                                                              │
│  GET  /                         → registry (list workspaces) │
│  GET  /registry/:id             → describeWorkspace() JSON   │
│  WS   /rooms/:room              → Yjs sync relay (central)   │
│  GET  /openapi                  → OpenAPI docs                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  .use() with { prefix }:                              │  │
│  │    /entries/*       → entriesApp (Elysia instance)    │  │
│  │    /whispering/*    → whisperingApp                   │  │
│  │    /tab-manager/*   → tabManagerApp                   │  │
│  │    /my-custom-app/* → customApp                       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Each workspace app:                                         │
│    - Is its own Elysia instance with { prefix: '/{id}' }    │
│    - Has its own routes (tables, kv, actions)                │
│    - Lifecycle hooks scoped to the instance (local default)  │
│    - Full Eden Treaty type inference preserved                │
│    - Full OpenAPI docs merged into parent                     │
└──────────────────────────────────────────────────────────────┘
```

### Workspace Directory Layout

Workspaces have two "weights" — installed from a registry, or symlinked from a developer's local project. Both have the same directory structure:

```
~/.epicenter/
├── config.json                          # Global: registries, default port
│
├── workspaces/
│   │
│   │  # INSTALLED: Downloaded from registry, Epicenter manages lifecycle
│   ├── epicenter.entries/
│   │   ├── epicenter.config.ts          # Default export: WorkspaceClient
│   │   ├── package.json                 # Isolated deps (optional)
│   │   ├── node_modules/               # bun install'd (if package.json exists)
│   │   ├── manifest.json               # jsrepo provenance: registry, version, hash
│   │   └── data/
│   │       └── workspace.yjs           # Persisted Y.Doc
│   │
│   │  # DEVELOPED: Lives in a git repo elsewhere, symlinked in
│   └── my-custom-app -> ~/projects/my-custom-app  # symlink via `epicenter add`
│       ├── epicenter.config.ts          # Developer owns this file
│       ├── package.json
│       └── data/
│           └── workspace.yjs
│
└── cache/                              # jsrepo manifest cache
    └── jsrepo-manifest.json
```

**Discovery is always a single `readdir()`** on `~/.epicenter/workspaces/`. Symlinks are transparent — the orchestrator follows them and imports the `epicenter.config.ts` at the resolved path. If a symlink is broken (developer deleted the project), the orchestrator logs a warning and skips it, same as any other import failure.

**Two CLI commands map to the two weights:**
- `epicenter install <registry/block>` → creates a directory in `workspaces/` (installed)
- `epicenter add <path>` → creates a symlink in `workspaces/` pointing to an existing directory (developed)

### How a Workspace Becomes an App

```
STEP 1: Author writes epicenter.config.ts (DATA CONTRACT — schema only)
──────────────────────────────────────────────────────────────────────
import { createWorkspace, defineTable, defineQuery, defineMutation } from '@epicenter/workspace';

const posts = defineTable({ /* schema */ });

// Default export: the BUILDER (not terminal). No actions, no extensions.
export default createWorkspace({ id: 'my-app', tables: { posts } });

// Optional: export shared action factories for DRY across runtimes
export const coreActions = (c) => ({
  posts: {
    getAll: defineQuery({ handler: () => c.tables.posts.getAllValid() }),
    create: defineMutation({ handler: (input) => c.tables.posts.create(input) }),
  },
});


STEP 2: Each runtime chains extensions + actions as needed
──────────────────────────────────────────────────────────
// Bun sidecar (server) — chains extensions AND actions
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withExtension('markdown', () => markdownProjection({ target: '~/notes/' }))
  .withActions((c) => ({
    ...coreActions(c),
    posts: {
      ...coreActions(c).posts,
      deleteAll: defineMutation({ handler: () => c.tables.posts.clear() }),
      exportToCsv: defineMutation({ handler: () => { /* FS write */ } }),
    },
  }));

// Browser SPA — chains only actions (no FS extensions possible)
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace.withActions((c) => ({
  ...coreActions(c),
  // Browser-specific actions if any
}));


STEP 3: Orchestrator composes server clients
────────────────────────────────────────────
// Create a prefixed Elysia app for this workspace
const workspaceApp = new Elysia({ prefix: `/${client.id}` })
  .use(createWorkspacePlugin([client]));

// Compose into orchestrator via .use() — preserves types + OpenAPI
orchestrator.use(workspaceApp);


STEP 4: Sync relay registered centrally
────────────────────────────────────────
orchestrator.use(
  new Elysia({ prefix: '/rooms' }).use(createSyncPlugin({
    getDoc: (room) => {
      // All workspace Y.Docs accessible by room ID
      const client = workspaces[room];
      return client?.ydoc ?? createEphemeralDoc(room);
    },
  }))
);


STEP 5: SPA connects via Yjs sync (local-first, no HTTP for data)
─────────────────────────────────────────────────────────────────
// SPA already has its own Y.Doc from importing the config (Step 2).
// Connect to the Yjs WebSocket room — all data syncs automatically.
ws://localhost:3913/rooms/my-app   → Yjs sync (bidirectional)

// Actions execute locally on the browser's Y.Doc:
client.actions.posts.getAll();     // Local read — zero latency
client.actions.posts.create({});   // Local write — syncs to server via WS

// Server-only actions (deleteAll, exportToCsv) are NOT on the SPA's client.
// The SPA can discover them via awareness protocol and proxy via HTTP if needed.
```

### Standalone Mode (No Orchestrator)

Any workspace can run independently. `createLocalServer()` takes a `clients` array of `AnyWorkspaceClient` objects — there is no separate "createWorkspaceServer". A standalone workspace is just `createLocalServer` with a single client.

Since the config exports a builder (not terminal), the standalone runner must chain extensions and actions before passing to `createLocalServer`:

```typescript
// epicenter.standalone.ts (or inline in the CLI's `epicenter run` command)
import { createLocalServer } from '@epicenter/server';
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withActions((c) => coreActions(c));

createLocalServer({ clients: [client], port: 4000 }).start();
```

```bash
# The CLI wraps this pattern:
epicenter run epicenter.entries --port 4000
```

This produces an identical API surface to being mounted in the orchestrator — same routes, same sync, same Eden Treaty types. The workspace doesn't know or care whether it's mounted or standalone. The only difference between "orchestrator" and "standalone" is how many clients are in the array passed to `createLocalServer()` and what extensions/actions each runtime chains.

### Remote Sync (Hosted App + Local Data)

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  myapp.com          │     │  Hub Relay        │     │  Local Epicenter    │
│  (hosted workspace) │────▶│  (Yjs WS rooms)  │◀────│  (Bun sidecar)     │
│                     │     │                    │     │                     │
│  Same epicenter     │     │  Room: "my-app"   │     │  Same epicenter     │
│  .config.ts         │     │  Merges via CRDT  │     │  .config.ts         │
└─────────────────────┘     └──────────────────┘     └─────────────────────┘
```

Both the hosted version and local instance use the same `epicenter.config.ts` schema. They connect to the same hub room. Yjs CRDTs handle conflict-free merging. No special sync protocol — this is what Yjs already does.

### The epicenter.config.ts as Universal Contract

The config file is portable across all runtime contexts — server (Bun orchestrator, standalone), browser (Svelte SPA), or edge (Cloudflare Worker). This portability is possible because the config contains only the data contract: schema definitions and a Y.Doc. Actions and extensions are chained per-runtime.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  epicenter.config.ts (DATA CONTRACT — portable, runs anywhere)                    │
│                                                                                   │
│  ┌─────────────┐   ┌──────────────────┐   ┌──────────────────────────────────┐  │
│  │  Schema      │   │  UI Hints        │   │  Shared Action Factories         │  │
│  │  - tables    │   │  - default views  │   │  (optional named exports)        │  │
│  │  - fields    │   │  - column ordering│   │  - coreActions = (c) => ({...}) │  │
│  │  - types     │   │  - display names  │   │  - reusable across runtimes     │  │
│  │  - kv stores │   │                   │   │                                  │  │
│  └─────────────┘   └──────────────────┘   └──────────────────────────────────┘  │
│                                                                                   │
│  Default export: createWorkspace(config) → WorkspaceClientBuilder                │
│  Y.Doc created eagerly. Builder is chainable — NOT terminal.                     │
│  No .withExtension() or .withActions() in the config.                            │
└──────────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────┐
                    │  import workspace   │
                    │  from config        │
                    └──────┬──────────────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌──────────────────┐ ┌────────────────┐ ┌────────────────────┐
│  Bun Sidecar     │ │  Browser SPA   │ │  Hosted Server     │
│                  │ │                │ │                    │
│  .withExtension  │ │  .withActions  │ │  .withExtension    │
│    persistence   │ │    coreActions │ │    durableObjects  │
│    markdown      │ │               │ │  .withActions      │
│  .withActions    │ │  (no FS deps) │ │    coreActions     │
│    coreActions   │ │               │ │    sendWebhook     │
│    deleteAll     │ │               │ │    notifyEmail     │
│    exportToCsv   │ │               │ │                    │
└──────────────────┘ └────────────────┘ └────────────────────┘
         │                  │                    │
         └──────────────────┼────────────────────┘
                            ▼
                  Yjs sync (all converge on same data)
                  Awareness (each peer advertises its actions)
```

**Three layers, three portability levels:**
- **Schema** (in config): Universal. Must be identical everywhere for Yjs sync to work.
- **Actions** (per-runtime): Context-dependent. Different runtimes expose different capabilities. Shared action factories (named exports) prevent duplication for common CRUD.
- **Extensions** (per-runtime): Environment-specific. FS projections on server, IndexedDB persistence in browser, Durable Objects on edge.

**Why this works**: `createWorkspace()` eagerly creates a `Y.Doc`. The builder uses immutable state, so branching is safe — multiple runtimes can chain different extensions/actions from the same base without interference. Each import in a different process creates a fresh Y.Doc. Yjs sync handles convergence.

**Awareness as action discovery**: Each peer can advertise its available actions via the Yjs awareness protocol. The SPA sees that the Bun sidecar has `deleteAll` and `exportToCsv`, and can proxy those calls via HTTP. The user sees all capabilities across the network, even actions that only run on the server.

**Browser import pattern**: The Svelte SPA imports the config, chains its own actions, and operates on a local Y.Doc synced via WebSocket. Zero HTTP round-trips for data operations. The HTTP API layer becomes optional — useful for non-browser clients (CLI, curl) and for proxying server-only actions, but not required for the SPA's own data path.

## Implementation Plan

### Phase 1: Workspace-as-Elysia-App Pattern

- [ ] **1.1** Create `createWorkspaceApp(client)` that returns a standalone Elysia instance for a single workspace (tables, KV, actions — no sync, no auth). The instance should accept a `prefix` option so it can be composed into a parent.
- [ ] **1.2** Refactor `createLocalServer()` to compose workspace apps via `.use()` with `{ prefix: '/{id}' }` instead of the current shared `createWorkspacePlugin` that uses `/:workspaceId` params for all workspaces.
- [ ] **1.3** Verify Eden Treaty type inference works end-to-end: `treaty<OrchestratorApp>('localhost:3913').entries.tables.posts.get()` should have full types.
- [ ] **1.4** Add `/registry` endpoint that returns `describeWorkspace()` for all composed workspaces, including their prefix paths.

### Phase 2: CLI as Package Manager

- [ ] **2.1** Add `epicenter install <registry/block>` — fetches source via jsrepo programmatic API (`registry.getProviderState` → `registry.fetchManifest` → `registry.getRemoteBlocks` → `registry.fetchRaw` per file, write to disk via Bun), creates workspace directory in `~/.epicenter/workspaces/`, generates `package.json`, runs `bun install` if deps present
- [ ] **2.2** Add `epicenter add <path>` — validates that `<path>/epicenter.config.ts` exists, creates a symlink in `~/.epicenter/workspaces/<dirname>` pointing to the given path. This is how developers register workspaces that live in their own git repos.
- [ ] **2.3** Add `epicenter uninstall <workspace-id>` — deletes the workspace directory (or removes symlink for `add`'d workspaces)
- [ ] **2.4** Add `epicenter ls` — lists all workspaces from `~/.epicenter/workspaces/`, showing weight (installed/linked/developed) and status
- [ ] **2.5** Add `epicenter update <workspace-id>` — re-fetches from registry, preserves `data/`
- [ ] **2.6** Write `manifest.json` on install with provenance (registry source, version, hash)

### Phase 3: Orchestrator Server

- [ ] **3.1** Build orchestrator that scans `~/.epicenter/workspaces/`, imports each `epicenter.config.ts`, creates workspace apps, mounts them
- [ ] **3.2** Centralize sync relay — orchestrator owns all WebSocket rooms, maps room IDs to workspace Y.Docs
- [ ] **3.3** Serve Svelte SPA via `@elysiajs/static` with `indexHTML: true` for SPA fallback
- [ ] **3.4** Wire Tauri sidecar to spawn orchestrator (defaults to 3913, falls back to OS-assigned port if taken), read actual port, create WebView

### Phase 4: Standalone Run + Remote Sync

- [ ] **4.1** Add `epicenter run <workspace-id> [--port N]` — runs a single workspace as a standalone server
- [ ] **4.2** Document the remote sync pattern: hosted app + local instance both connect to hub room
- [ ] **4.3** Add `epicenter run <workspace-id> --hub <url>` to connect a standalone workspace to a hub relay

### Phase 5: Deployment as Hosted App

- [ ] **5.1** Document how to deploy a workspace as a standalone hosted app (Dockerfile, fly.io, Railway patterns)
- [ ] **5.2** Add `epicenter deploy <workspace-id>` scaffolding — generates deployment config from `epicenter.config.ts`
- [ ] **5.3** Ensure standalone mode exposes `/registry` endpoint so other instances can discover the workspace schema
- [ ] **5.4** Add CORS configuration for standalone mode so browser-based clients can hit the API directly

### Phase 6: Workspace Extensions (Filesystem Projections)

Extensions allow workspaces to reactively materialize Y.Doc data to arbitrary filesystem locations. This is how a workspace writes Markdown files, JSON exports, or any other file-based output without requiring the workspace itself to live in the output directory.

- [ ] **6.1** Define the `.withExtension()` API on the workspace builder — extensions receive access to the workspace's Y.Doc observation lifecycle and a target path
- [ ] **6.2** Implement `markdownProjection` as the first built-in extension — subscribes to `observeDeep` on a table's Y.Map, diffs changes, writes/deletes `.md` files at the target path
- [ ] **6.3** Wire extension lifecycle into the orchestrator — start extensions on workspace mount, stop on unmount. Extensions run in the same process as the orchestrator.
- [ ] **6.4** Support multiple extensions per workspace (e.g., Markdown to `~/notes/` AND JSON to `~/backups/`)
- [ ] **6.5** Handle extension errors gracefully — a failing extension should not crash the workspace or orchestrator. Log errors, expose status in the registry.
**Example API:**

Since the config exports the builder (not terminal), each runtime chains extensions and actions independently. `.withActions()` is terminal — extensions must come before actions in the chain.

```typescript
// epicenter.config.ts — DATA CONTRACT (builder, no extensions, no actions)
export default createWorkspace({ id: 'journal', tables: { entries } });

export const coreActions = (c) => ({
  entries: {
    getAll: defineQuery({ handler: () => c.tables.entries.getAllValid() }),
    create: defineMutation({ handler: (input) => c.tables.entries.create(input) }),
  },
});

// Bun sidecar — chains extensions + actions
import workspace, { coreActions } from './epicenter.config.ts';

const client = workspace
  .withExtension('persistence', () => filePersistence('./data/workspace.yjs'))
  .withExtension('markdown-notes', () => markdownProjection({
    target: '~/notes/journal/',
    table: 'entries',
    filename: (entry) => `${entry.date}.md`,
    render: (entry) => entry.body,
  }))
  .withExtension('markdown-obsidian', () => markdownProjection({
    target: '~/obsidian-vault/journal/',
    table: 'entries',
    filename: (entry) => `${entry.date}.md`,
    render: (entry) => entry.body,
  }))
  .withActions((c) => ({
    ...coreActions(c),
    entries: {
      ...coreActions(c).entries,
      deleteAll: defineMutation({ handler: () => c.tables.entries.clear() }),
    },
  }));
```

**Key insight**: The workspace stays centralized in `~/.epicenter/workspaces/`. Extensions project *outward* to wherever the user wants output. The config exports a builder (not terminal), so every runtime — browser SPA, Bun sidecar, hosted server — chains exactly the extensions and actions it needs. This cleanly separates "what the data looks like" (config) from "what you can do with it" (per-runtime).

## Hard Problems

These are the genuinely difficult parts of this architecture. Everything else is plumbing.

### 1. Schema Evolution After Updates

When a workspace is updated via `epicenter update`, the new `epicenter.config.ts` may add/remove tables or change field types. The persisted `workspace.yjs` still has the old schema's data. Yjs is schema-tolerant — old fields remain, new fields get defaults — but `getAllValid()` may filter out stale rows.

When two instances of the same workspace sync via hub and one updates to a newer schema version, they'll briefly disagree on the schema. This is fine — Yjs doesn't care about schema, and both instances render what their local schema understands. Unknown fields are preserved in the Y.Doc but not displayed.

**Recommendation**: Accept drift for v1. The SPA should handle unknown fields gracefully since `getAllValid()` already filters by the current schema.

### 2. Process Isolation at Scale

The orchestrator runs all workspaces in a single Bun process. This is great for simplicity (no port management, no WebSocket relay) but means:

- A memory leak in one workspace affects all others
- A blocking operation (heavy computation, slow network call) blocks the event loop for all workspaces
- A crash kills everything

**The tension**: 20 apps in one process is fine for personal use. 200 apps (a team server) is not.

**At what scale does this break?**
- **Memory**: Each Y.Doc is typically small (KB to low MB). 20 workspaces ≈ 20-200 MB. Bun handles this easily.
- **CPU**: Yjs sync is cheap. Action handlers are the wildcard — if a workspace does AI inference or image processing, it could block.
- **Crash blast radius**: One `process.exit()` or unhandled exception kills everything.

**Possible approaches for the future** (not v1):
- **Worker threads**: Bun supports `Worker`. Each workspace could run in its own worker. The orchestrator forwards requests via `postMessage`. This gives memory isolation and crash isolation.
- **Subprocess per workspace**: Each workspace runs as its own Bun process. The orchestrator is a reverse proxy. This is the heaviest isolation but loses the `.use()` type safety.
- **Selective isolation via `.mount(path, handler.fetch)`**: Only untrusted third-party workspaces get mounted via the raw handler path (losing types and OpenAPI). First-party workspaces stay composed via `.use()`. This is the lightest isolation upgrade — same process, but opaque request boundary.
- **Selective isolation via subprocess**: Same as above but stronger — untrusted workspaces run in their own Bun process. The orchestrator `fetch`-forwards to `localhost:{childPort}`. This is the only approach that provides true crash isolation.

**Recommendation**: Single process for v1. It handles the personal-use scale. Add worker-based isolation when third-party workspaces arrive.

### 3. The "20 Apps" UI Problem

If you have 20 workspaces mounted, the Svelte shell needs to render a coherent UI across all of them. Currently, each workspace gets a generic table/KV browser. But workspaces might want custom UI:

- A journal app wants a timeline view
- A bookmark manager wants a card grid
- A kanban board wants columns with drag-and-drop

**The tension**: The orchestrator serves a single SPA. Custom per-workspace UI means either:
- The SPA is a generic shell that renders all workspaces as tables (current approach, boring but works)
- Workspaces can ship their own Svelte components (powerful but complex — code loading, security, bundle size)
- Workspaces define "views" declaratively (column layouts, card templates) that the SPA interprets

**Recommendation**: Generic table shell for v1. Explore declarative view definitions for v2 (a workspace's config could include `views: [{ type: 'kanban', groupBy: 'status' }]`). Custom Svelte components are a v3 concern — they require a plugin sandbox and dramatically increase complexity.

## Edge Cases

### Workspace with External Dependencies

1. A workspace's `epicenter.config.ts` imports from `nanoid` or another npm package.
2. The workspace directory needs its own `package.json` with that dependency listed.
3. `epicenter install` must run `bun install` in the workspace directory after downloading source.
4. If `package.json` is missing, the workspace can only import from `@epicenter/workspace` (globally available).

### Duplicate Workspace IDs

1. User installs two workspaces that both export `id: 'my-app'`.
2. The orchestrator must detect this at mount time and fail with a clear error.
3. Already handled by `discoverAllWorkspaces()` in `packages/cli/src/discovery.ts:88-95`.

### Workspace Crashes During Import

1. A workspace's `epicenter.config.ts` throws on import (syntax error, missing dep).
2. The orchestrator should log the error and continue loading other workspaces.
3. The failed workspace appears in the registry as `{ status: 'error', message: '...' }`.

### Schema Evolution After Update

1. User runs `epicenter update my-app`, which replaces `epicenter.config.ts` with a new version.
2. The new schema may add/remove tables or change field types.
3. The persisted `workspace.yjs` still has the old schema's data.
4. Yjs is schema-tolerant — old fields remain in the Y.Doc, new fields get defaults. But `getAllValid()` may filter out stale rows. This is the existing behavior and is acceptable.

### Data Trapped in Hidden Y.Doc (No Extensions Configured)

1. Non-technical user installs a journal workspace via the Tauri app.
2. They write 200 journal entries over 6 months.
3. They uninstall Epicenter, or their machine dies, or they want to export their data.
4. All 200 entries are in `~/.epicenter/workspaces/journal/data/workspace.yjs` — a binary CRDT file that no other app can read.
5. **Mitigations**: (a) The Tauri app should always offer an "Export" button that dumps table data as JSON/CSV/Markdown, independent of extensions. (b) If hub sync is configured, the data exists on the hub and can be recovered. (c) `epicenter export <workspace-id> --format json` as a CLI escape hatch. (d) Workspace authors can use `.withExtension()` to project data to user-visible locations.
6. **Principle**: The Y.Doc is the source of truth, but it must never be the *only* copy of user data in a human-readable format. At minimum, export must always be available via the app UI and CLI.

### Broken Symlink (Developed Workspace Removed)

1. Developer runs `epicenter add ~/projects/my-app`, creating a symlink in `~/.epicenter/workspaces/my-app`.
2. Developer deletes or moves `~/projects/my-app`.
3. The symlink is now dangling. `readdir()` still returns it, but `readFileSync` on the target fails.
4. The orchestrator should detect this (same codepath as "Workspace Crashes During Import"), log a warning, and skip. The workspace appears in `epicenter ls` as `{ status: 'error', message: 'symlink target not found' }`.
5. `epicenter remove my-app` cleans up the dangling symlink.

### jsrepo Import Rewriting

1. jsrepo automatically rewrites imports in downloaded files.
2. This could mangle `@epicenter/workspace` imports or workspace-specific relative imports.
3. Options: (a) disable watermark + import rewriting via jsrepo config, (b) post-process to restore expected imports, (c) use jsrepo's raw fetch mode to skip transformations.

## Resolved Questions

These were open during design and have been decided. Kept here for context so implementing agents understand the reasoning.

1. **Where should workspaces be stored?**
   - **Decision**: `~/.epicenter/workspaces/` (centralized dotfile directory). See "Storage location" and "Discovery model" in Design Decisions.
   - **Alternatives rejected**: `~/Library/Application Support/Epicenter/` (path has spaces, macOS-only), `~/Documents/Epicenter/` (mixes app internals with user content), distributed paths in `config.json` (stale path problem, single point of failure).
   - **Key enabler**: The extension/projection system means user-visible data doesn't need to live *in* `~/.epicenter/` — it gets projected outward to user-chosen locations.

2. **How should developer-authored workspaces (in git repos) be registered?**
   - **Decision**: `epicenter add <path>` creates a symlink in `~/.epicenter/workspaces/`. The orchestrator follows symlinks transparently. Broken symlinks are handled the same as import failures.
   - **Alternative rejected**: Path registry in `config.json` (corrupts, gets stale, requires validation on every startup).

3. **Where do non-technical users see their data?**
   - **Decision**: Extensions (`.withExtension()`) project Y.Doc data outward to user-visible locations (`~/Documents/`, Obsidian vaults, etc.). The Y.Doc in `~/.epicenter/` is internal plumbing — users interact with projected output or the Tauri app UI. Export via app UI and CLI is always available as a fallback.

4. **What happens to the current `createWorkspacePlugin` approach?**
   - **Decision**: Replace entirely. The mount-per-workspace approach is strictly more flexible. The old parameterized approach (`/:workspaceId` params) is a special case.

5. **How should workspace-specific dependencies be managed?**
   - **Decision**: Each workspace has its own `package.json` + `node_modules/`. Bun installs are fast (~100ms) and disk is cheap. This gives maximum flexibility — workspaces can import any npm package, not just `@epicenter/workspace`.
   - **Alternative rejected**: Restricting workspaces to only import from `@epicenter/workspace` (too limiting — workspaces that call external APIs, use crypto libraries, etc. need their own deps).

6. **Should the CLI shell out to `jsrepo add` or use the programmatic API?**
   - **Decision**: Use jsrepo's programmatic API exported from `jsrepo/api` (`registry.getProviderState()`, `registry.fetchManifest()`, `registry.getRemoteBlocks()`, `registry.fetchRaw()`). File writing is not in the API — we write files via Bun's file APIs directly, which means no import rewriting occurs.
   - **Why programmatic over shelling out**: (a) We need custom post-processing anyway (generate `package.json`, run `bun install`, write `manifest.json` with provenance). (b) Avoids the import rewriting edge case — jsrepo's CLI automatically rewrites imports, which could mangle `@epicenter/workspace` paths. Programmatic control lets us skip that. (c) No subprocess overhead, error handling stays in-process.
   - **Alternative rejected**: Shelling out to `jsrepo add` via `Bun.$` (viable but gives less control over the install flow, and the import rewriting problem requires post-processing to fix anyway).

7. **How should the hub relay authorize room access?**
   - **Decision**: User-level auth via Better Auth JWT. The hub validates the JWT on WebSocket upgrade and checks room-level permissions (which workspaces has this user been granted access to?).
   - **Why**: Both self-hosted and Cloudflare-hosted hubs support Better Auth. Using the same auth system everywhere means one mechanism, one codebase, one login flow — regardless of whether the hub is local or remote. No separate token issuance or distribution needed.
   - **Alternative rejected**: Room-level access tokens (creates a "who issues the token and how does it reach the other instance" problem, introduces a second auth system alongside Better Auth).

8. **Should `epicenter.config.ts` be portable across browser and server?**
   - **Decision**: Yes. The config's default export is a `WorkspaceClientBuilder` (result of `createWorkspace()` — not terminal). It contains NO extensions, NO actions, and NO server-only dependencies. This allows any runtime to import it and chain its own extensions and actions.
   - **Why**: `createWorkspace()` eagerly creates a Y.Doc, and Yjs is fully isomorphic (runs in browser, Bun, Deno, edge). The builder uses immutable state, so branching is safe — multiple runtimes chain different things from the same base. Actions are context-dependent (a Bun sidecar might expose `deleteAll` and `exportToCsv` that the browser SPA shouldn't have). Extensions are environment-specific (FS projections on server, IndexedDB in browser).
   - **Implication**: Neither `.withExtension()` nor `.withActions()` appear in the config. The config is purely the data contract (schema). Shared action factories can be exported as named exports for DRY across runtimes.
   - **Alternative rejected**: Putting actions in the config (forces all runtimes to have identical capabilities, prevents server-only or browser-only actions).

9. **Should `mount()` or `.use()` compose workspace apps?**
   - **Decision**: `.use()` with `{ prefix }` for first-party workspaces. `.mount(path, handler.fetch)` reserved for untrusted third-party code.
   - **Why**: DeepWiki research revealed a critical nuance — `mount(path, elysiaInstance)` auto-resolves via `.use()` anyway, so the only way to get true isolation is `mount(path, instance.handle)`, which loses Eden Treaty types, OpenAPI docs, and WebSocket support. Since all three are essential (types for the CLI/SPA, OpenAPI for discoverability, WebSocket for sync), `.use()` is the only viable choice for v1. The `.mount(path, handler.fetch)` escape hatch exists for v2+ when third-party workspaces need lifecycle isolation.
   - **Alternative rejected**: `.mount()` for all workspaces (kills types, kills OpenAPI, kills WS — unacceptable tradeoffs for the core use case).

## Open Questions

1. **How should awareness advertise per-runtime actions?**
   - Each runtime has different actions available (SPA has CRUD, Bun sidecar has CRUD + FS operations). The SPA should be able to discover and proxy server-only actions.
   - Option A: Each peer broadcasts its action list via Yjs awareness protocol. The SPA shows server-only actions as "available via server" and proxies calls via HTTP.
   - Option B: The `/registry` endpoint includes the server's full action list. The SPA knows which actions it has locally and which require HTTP proxy.
   - Option C: Both — awareness for real-time capability discovery (peer goes offline = actions disappear), registry for static discovery.
   - **Leaning toward Option C** — awareness handles the dynamic case (which peers are online and what can they do), registry handles the static case (what does this workspace support in general).

2. **Should shared action factories be a convention or a framework feature?**
   - Currently, shared actions are just named exports (`export const coreActions = ...`). This is a convention, not enforced.
   - Could the framework provide `defineActions()` that returns a reusable factory, or is the plain function export sufficient?
   - **Leaning toward convention** — a plain function export is simple, well-understood, and doesn't require framework support. Adding `defineActions()` would add API surface for minimal benefit.

## Success Criteria

### Phase 1-3 (Core)
- [ ] A workspace installed via `epicenter install` appears in the orchestrator's registry
- [ ] A workspace registered via `epicenter add <path>` (symlink) appears in the orchestrator's registry identically to an installed workspace
- [ ] Each workspace's table CRUD and actions are accessible at `/{workspaceId}/...`
- [ ] WebSocket sync works for all mounted workspaces via the central relay
- [ ] The Svelte SPA can discover and render workspaces from the `/registry` endpoint
- [ ] `epicenter <workspace-id> tables <table> list` works against a running orchestrator or standalone instance

### Phase 4 (Standalone)
- [ ] A workspace can be run standalone via `epicenter run <id>` with an identical API surface
- [ ] Standalone mode with `--hub` flag syncs data to/from a hub relay
- [ ] A standalone workspace exposes `/registry` so others can link to it

### Phase 5 (Deployment)
- [ ] A workspace can be deployed as a standalone hosted app with a single command
- [ ] The deployed app exposes `/registry` so other instances can discover its schema

### Phase 6 (Extensions)
- [ ] A workspace with `.withExtension(markdownProjection(...))` writes Markdown files to the target path on Y.Doc changes
- [ ] Multiple extensions per workspace work independently (different targets, different formats)
- [ ] Extension failures are isolated — a broken extension doesn't crash the workspace or orchestrator
- [ ] Extensions run in the same process as the workspace (orchestrator or standalone)

## Conceptual Model: The Filesystem as an App Store

The mental model that ties everything together: **your `~/.epicenter/workspaces/` directory is an app store**. Each subdirectory is an installed app. Some are downloaded from a registry (jsrepo). Some are symlinked from a developer's git repo. The orchestrator is the runtime that loads them all.

This mirrors how mobile operating systems work:
- **Install** = download source + deps into a directory (like installing an APK/IPA)
- **Add** = symlink a developer's existing workspace into the app store (like sideloading)
- **Mount** = load into the orchestrator process (like the OS loading an app into memory)
- **Run standalone** = launch outside the orchestrator (like running an app in debug mode)

### Why Centralized Directory, Not Distributed Paths

An alternative design was considered: workspaces live anywhere on disk, and Epicenter tracks them via a path list in `config.json` (the Obsidian model). This was rejected for the centralized-with-symlinks approach because:

1. **Stale path problem**: If a user moves or deletes a directory, `config.json` still points at it. The orchestrator must handle N missing paths on every startup. This is a persistent UX paper cut.
2. **Single point of failure**: A corrupted or deleted `config.json` means Epicenter forgets about every workspace. With the centralized model, the directory *is* the source of truth — there's nothing to corrupt.
3. **Discovery simplicity**: One `readdir()` vs "read config, validate each path, handle missing ones."
4. **Symlinks solve the 90% case**: The only scenario that needs workspaces outside `~/.epicenter/` is developer-authored workspaces in git repos. `epicenter add <path>` creates a symlink, which is transparent to the orchestrator and self-evidently broken (dangling symlink) if the target disappears.

The centralized model handles both workspace weights (installed, developed) without introducing a mutable registry of paths.

The key difference from mobile: **every app shares a universal data layer (Yjs)**. Apps don't have siloed databases — they have CRDTs that can sync with any other instance of the same schema. Two instances of the same workspace on different machines, both connected to a hub, are looking at the same data.

### The epicenter.config.ts is Like package.json for Apps

Just as `package.json` describes an npm package (name, version, dependencies, entry points), `epicenter.config.ts` describes a workspace app (ID, tables, actions, schema). It's the single file that makes a directory into an app.

The difference is that `epicenter.config.ts` is executable — it's not just metadata, it's the actual app definition. `createWorkspace()` eagerly creates a `Y.Doc` and returns a `WorkspaceClientBuilder`. Chaining `.withActions()` (terminal) produces a `WorkspaceClientWithActions` — the default export. The schema types are runtime-validated (via arktype). The action handlers are real functions that operate on the Y.Doc. This means the same file serves as both the "manifest" and the "implementation" — and because Yjs is isomorphic, it works in browsers too.

### Why Yjs Makes Multi-Instance Sync Trivial

The typical approach to syncing a desktop app with a hosted version requires:
1. A REST API for CRUD operations
2. A conflict resolution strategy
3. An offline queue with retry logic
4. A sync protocol with change tracking (last-modified timestamps, version vectors)
5. A merge strategy for concurrent edits

Yjs eliminates all five. The Y.Doc is the single source of truth. Every mutation is a CRDT operation that commutes — order doesn't matter, every peer converges. The "sync protocol" is just y-websocket, a well-tested library. Offline support is automatic — the Y.Doc accumulates local changes and merges them when the connection resumes.

This means two instances of the same workspace — one on your laptop, one deployed as a web service — don't need any special plumbing to sync. They both connect to a hub room, and Yjs does the rest. The local `workspace.yjs` file is a snapshot of the Y.Doc for fast startup and offline access.

## References

- `packages/server/src/local.ts` — Current `createLocalServer()` composition
- `packages/server/src/workspace/plugin.ts` — Current shared workspace plugin (to be refactored)
- `packages/server/src/workspace/actions.ts` — Per-action static route registration
- `packages/server/src/sync/plugin.ts` — Yjs WebSocket sync relay
- `packages/cli/src/discovery.ts` — `loadClientFromPath()` and `discoverAllWorkspaces()`
- `packages/cli/src/cli.ts` — Current CLI two-mode dispatch
- `packages/epicenter/src/workspace/describe-workspace.ts` — Workspace introspection for registry
- `specs/20260225T000000-bun-sidecar-workspace-modules.md` — Prior spec: sidecar + dynamic loading
- `specs/20260225T172506-epicenter-workspace-module-redesign.md` — Prior spec: module redesign
- `docs/articles/tauri-bun-dual-backend-architecture.md` — Sidecar spawning pattern
