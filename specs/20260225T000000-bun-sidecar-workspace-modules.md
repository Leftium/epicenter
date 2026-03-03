# Bun Sidecar + Dynamic Workspace Modules

**Date:** 2026-02-25
**Feature:** Replace Tauri-hosted SPA with Bun sidecar serving ElysiaJS + dynamic TypeScript workspace loading + TanStack AI integration

> **Topology note**: The Bun sidecar (local server, `createLocalServer`) handles workspace CRUD, extensions, actions, persisted Y.Docs, and local Yjs relay between the SPA and the server's Y.Doc. The hub server (`createHubServer`) is a separate cloud deployment that handles AI proxy/streaming, Better Auth (session issuance), and cross-device Yjs relay. AI requests (TanStack AI, chat) from the SPA go directly to the hub, not the sidecar. The sidecar validates session tokens by calling the hub's `/auth/get-session` endpoint but does not issue tokens or stream AI responses itself.

## Problem

Workspaces are hardcoded TypeScript templates baked into the app source (`apps/epicenter/src/lib/templates/`). Adding a new workspace means editing code and rebuilding. The frontend uses Tauri FS plugins directly for persistence, coupling the app to the WebView runtime. There's no way to install, distribute, or dynamically load workspace definitions at runtime.

## Solution

A compiled Bun binary runs as a Tauri sidecar. It hosts an ElysiaJS server that:
1. Serves the Svelte SPA as static files
2. Dynamically imports workspace TypeScript files from disk at runtime
3. Extracts JSON Schema via `describeWorkspace()` for dynamic UI rendering
4. Exposes workspace tables/actions as REST API + WebSocket sync
5. Integrates TanStack AI so workspace actions become AI-callable tools

The frontend talks to the sidecar via HTTP/WebSocket instead of Tauri FS plugins. Workspaces are distributed as single TypeScript files via jsrepo.

## Existing Infrastructure to Reuse

These already exist and form the foundation:

| Component | File | What it does |
|-----------|------|-------------|
| Local Elysia server | `packages/server/src/local.ts` | `createLocalServer()` — CORS, OpenAPI, sync plugin, workspace plugin, auth |
| Workspace REST plugin | `packages/server/src/workspace/plugin.ts` | Mounts table CRUD + action routes per workspace client |
| Dynamic TS import | `packages/cli/src/discovery.ts` | `loadClientFromPath()` — imports `epicenter.config.ts`, validates `isWorkspaceClient()` |
| Workspace introspection | `packages/epicenter/src/workspace/describe-workspace.ts` | `describeWorkspace(client)` — extracts JSON Schema descriptor |
| Action iteration | `packages/epicenter/src/shared/actions.ts` | `iterateActions()` — walks action tree for introspection |
| Sidecar architecture doc | `docs/articles/tauri-bun-dual-backend-architecture.md` | Exact Rust code for spawning sidecar, reading port, building WebviewWindow |
| Sync plugin | `packages/server/src/sync/plugin.ts` | WebSocket Yjs sync relay |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Tauri Process                         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Rust (thin shell)                                 │  │
│  │  setup() → spawn epicenter-sidecar                 │  │
│  │         → read PORT:<N> from stdout                │  │
│  │         → WebviewWindow → http://127.0.0.1:N       │  │
│  │  invoke_handler: [native-only commands]             │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Bun Sidecar (compiled binary, ~45MB)              │  │
│  │  createLocalServer()                               │  │
│  │                                                    │  │
│  │  ElysiaJS Server:                                  │  │
│  │    GET /              → Svelte SPA (static)        │  │
│  │    GET /api/registry  → list workspace descriptors │  │
│  │    /workspaces/:id/*  → table CRUD + actions       │  │
│  │    /rooms/:id         → Yjs WebSocket sync         │  │
│  │                                                    │  │
│  │  Workspace Loader:                                 │  │
│  │    Scans ~/.epicenter/workspaces/*/                 │  │
│  │    Dynamically imports epicenter.config.ts files    │  │
│  │    Attaches Bun-native persistence extensions      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  WebView                                           │  │
│  │  loaded from http://127.0.0.1:N                    │  │
│  │  fetch('/api/...') → Bun sidecar (same origin)     │  │
│  │  WebSocket('/rooms/...') → Yjs sync (sidecar)      │  │
│  │  fetch('https://hub/.../chat') → AI streaming      │  │ ← hub
│  │  invoke('...') → Rust (native-only features)       │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘

Hub Server (cloud, separate deployment)
  createHubServer()
  ┌──────────────────────────────────────────────────────┐
  │  /auth/*        → Better Auth (session issuance)     │
  │  /ai/chat       → AI streaming (SSE)                 │
  │  /proxy/*       → AI provider key proxy              │
  │  /rooms/*       → Yjs relay (cross-device, ephemeral)│
  └──────────────────────────────────────────────────────┘
```

## Workspace File Convention

Each workspace is a directory under `~/.epicenter/workspaces/{id}/` with **isolated dependencies**:

```
~/.epicenter/workspaces/
├── epicenter.entries/
│   ├── epicenter.config.ts    # Workspace module (default export = WorkspaceClient)
│   ├── workspace.yjs          # Y.Doc binary (runtime-managed, not user-edited)
│   ├── package.json           # This workspace's dependencies (isolated)
│   ├── node_modules/          # This workspace's installed deps (isolated)
│   └── manifest.json          # Source registry, version, hash (for updates)
├── epicenter.whispering/
│   ├── epicenter.config.ts
│   ├── workspace.yjs
│   └── ...
```

### Why Isolated Dependencies (Not Shared)

Each workspace has its own `package.json` + `node_modules/` rather than sharing at the workspaces root:

- **Uninstall = delete the folder.** No orphaned deps, no cleanup logic.
- **No version conflicts.** Workspace A uses `nanoid@4`, workspace B uses `nanoid@5` — no problem.
- **Security containment.** A malicious workspace's deps can't poison other workspaces.
- **Clear ownership.** Looking at a workspace folder tells you exactly what it needs.
- **Bun installs are fast.** ~100ms for small dep trees. Disk space is negligible for a desktop app.

The tradeoff (duplicate deps, slightly more disk) is not meaningful for a desktop application where workspace dep trees are small.

### Workspace File Contract

The `epicenter.config.ts` file exports a **full WorkspaceClient** as default export. This matches the existing CLI convention in `packages/cli/src/discovery.ts`:

```typescript
// epicenter.config.ts
import { createWorkspace, defineWorkspace, defineTable, defineMutation, defineQuery } from '@epicenter/workspace';
import { type } from 'arktype';

const entries = defineTable(type({
  id: 'string',
  title: 'string',
  content: 'string',
  _v: '1',
}));

const workspace = defineWorkspace({
  id: 'epicenter.entries' as const,
  tables: { entries },
});

export default createWorkspace(workspace)
  .withActions((c) => ({
    entries: {
      getAll: defineQuery({
        description: 'List all entries',
        handler: () => c.tables.entries.getAllValid(),
      }),
      create: defineMutation({
        description: 'Create a new entry',
        input: type({ title: 'string' }),
        handler: ({ title }) => {
          c.tables.entries.upsert({ id: crypto.randomUUID(), title, content: '', _v: 1 });
        },
      }),
    },
  }));
```

The sidecar runtime adds platform extensions (Bun file persistence, sync) after importing the client. The client exports its schema and actions; the runtime owns lifecycle and I/O.

Validation on import (reuse `isWorkspaceClient()` from `packages/cli/src/discovery.ts:106-115`):
- Default export must have `id`, `tables`, `definitions` properties
- `id` must be a string
- Actions (if present) must be iterable via `iterateActions()`

---

## Phase 1: Bun Sidecar Serving SPA

**Goal**: Tauri spawns a Bun sidecar that serves the Svelte SPA and existing API.

### New Files

**`apps/epicenter/src-sidecar/main.ts`** — Sidecar entry point:
- Imports `createLocalServer()` from `@epicenter/server`
- Adds `@elysiajs/static` plugin for SPA serving (`indexHTML: true` for SPA fallback)
- Listens on port 0 (OS-assigned), prints `PORT:<N>` to stdout
- In Phase 1, loads the existing hardcoded templates as clients

### Modified Files

**`apps/epicenter/src-tauri/src/lib.rs`**:
- Replace current plugin-only setup with sidecar launcher
- Add `tauri_plugin_shell::init()`
- In `setup()`: spawn sidecar, read port from stdout, create WebviewWindow
- Reference implementation: `docs/articles/tauri-bun-dual-backend-architecture.md:117-154`

**`apps/epicenter/src-tauri/tauri.conf.json`**:
- Add `"bundle": { "externalBin": ["binaries/epicenter-sidecar"] }`
- Remove `build.frontendDist` (sidecar serves SPA)
- Keep `devUrl` + `beforeDevCommand` for dev mode

**`apps/epicenter/src-tauri/capabilities/default.json`**:
- Add `"shell:allow-spawn"`, `"shell:allow-execute"`
- Add `"remote": { "urls": ["http://localhost:*", "http://127.0.0.1:*"] }`
- Remove `fs:*` permissions (sidecar handles FS)

**`apps/epicenter/src-tauri/Cargo.toml`**:
- Add `tauri-plugin-shell` dependency
- Can remove `tauri-plugin-fs`, `tauri-plugin-sql`

### Build Pipeline

New scripts in `apps/epicenter/package.json`:
- `build:spa` — `vite build` → copies output to `src-sidecar/public/`
- `build:sidecar` — `bun build --compile --target=bun-darwin-arm64 src-sidecar/main.ts --outfile src-tauri/binaries/epicenter-sidecar-aarch64-apple-darwin`
- `build` — `build:spa && build:sidecar && tauri build`
- `dev:sidecar` — `bun --watch run src-sidecar/main.ts`

### Dependencies

Add to `apps/epicenter/package.json`: `@elysiajs/static`

---

## Phase 2: Dynamic Workspace Module Loading

**Goal**: Replace hardcoded templates with runtime-imported TypeScript files.

### New Files

**`packages/server/src/workspace-loader.ts`** — Multi-workspace scanner:
```typescript
import { join } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';

const CONFIG_FILENAME = 'epicenter.config.ts';

export async function loadWorkspaceModules(workspacesDir: string): Promise<AnyWorkspaceClient[]> {
  const glob = new Bun.Glob(`*/${CONFIG_FILENAME}`);
  const clients: AnyWorkspaceClient[] = [];

  for await (const path of glob.scan({ cwd: workspacesDir, onlyFiles: true })) {
    const fullPath = join(workspacesDir, path);
    const module = await import(Bun.pathToFileURL(fullPath).href);
    const client = module.default;

    if (!isWorkspaceClient(client)) {
      console.warn(`Skipping ${path}: invalid default export`);
      continue;
    }

    clients.push(client);
  }

  return clients;
}
```

Reuses `isWorkspaceClient()` from `packages/cli/src/discovery.ts:106-115`. Consider extracting it to a shared location.

**`packages/server/src/extensions/bun-persistence.ts`** — Bun-native Y.Doc persistence:
- Reads/writes `workspace.yjs` using `Bun.file()` and `Bun.write()`
- Same logic as `apps/epicenter/src/lib/yjs/workspace-persistence.ts` but using Bun APIs instead of Tauri FS
- Returns `{ whenReady, destroy }` extension interface

**`packages/server/src/workspace/management.ts`** — Workspace registry API:

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/registry` | List all loaded workspaces with `describeWorkspace()` output |
| `GET` | `/api/registry/:id` | Get single workspace descriptor (JSON Schema) |
| `POST` | `/api/registry/reload` | Re-scan workspaces dir and hot-reload modules |

### Modified Files

**`apps/epicenter/src-sidecar/main.ts`**:
- Replace hardcoded template loading with `loadWorkspaceModules(workspacesDir)`
- Attach `bunFilePersistence` extension to each loaded client
- Pass data dir via `EPICENTER_DATA_DIR` env var or default to `~/.epicenter`

### Standalone Workspace Files

Convert existing templates to standalone files:
- `apps/epicenter/src/lib/templates/entries.ts` → `epicenter.entries/epicenter.config.ts`
- `apps/epicenter/src/lib/templates/whispering.ts` → `epicenter.whispering/epicenter.config.ts`

These become the first "pre-installed" workspaces, copied to the data dir on first launch.

---

## Phase 3: Frontend Migration

**Goal**: Frontend talks to sidecar via HTTP/WS instead of Tauri FS.

### Modified Files

**`apps/epicenter/src/lib/workspaces/dynamic/service.ts`**:
- Replace `@tauri-apps/plugin-fs` calls with `fetch('/api/registry/...')`
- `listWorkspaces()` → `fetch('/api/registry')`
- `createWorkspaceDefinition()` → `POST /api/registry` (sidecar writes to disk)
- `deleteWorkspace()` → `DELETE /api/registry/:id`

**`apps/epicenter/src/lib/yjs/workspace.ts`**:
- Remove `WORKSPACE_TEMPLATE_BY_ID` lookup
- Fetch workspace descriptor from `/api/registry/:id`
- Create local Y.Doc that syncs with sidecar via WebSocket (`/rooms/:id`)
- The sidecar's Y.Doc has the persistence extension — the frontend Y.Doc is ephemeral

**`apps/epicenter/src/routes/(workspace)/workspaces/[id]/+layout.ts`**:
- Fetch descriptor from API instead of loading from disk
- Connect to sync room instead of creating client locally

**`apps/epicenter/src/lib/yjs/workspace-persistence.ts`**:
- Delete this file. Persistence moves to the sidecar.

### Remove Tauri Plugin Dependencies

From `apps/epicenter/package.json`, remove:
- `@tauri-apps/plugin-fs`
- `@tauri-apps/plugin-sql`
- `@tauri-apps/api/path` imports

Keep `@tauri-apps/api/core` for `invoke()` (native-only features like audio, shortcuts, tray).

### Web Mode

Since the frontend now uses HTTP/WS, the same SPA works without Tauri:
```bash
bun run apps/epicenter/src-sidecar/main.ts
# Opens http://127.0.0.1:3913 — full app, no Tauri needed
```

Feature-detect Tauri with `'__TAURI_INTERNALS__' in window` for native-only features.

---

## Phase 4: jsrepo Distribution

**Goal**: Install workspace definitions from registries.

### New Files

**`packages/server/src/workspace/installer.ts`**:
- Uses jsrepo programmatic API to download workspace TypeScript files
- Creates workspace directory, writes `epicenter.config.ts`
- Runs `Bun.spawn(['bun', 'install'], { cwd: workspaceDir })` if `package.json` exists
- Dynamically imports the new module and adds it to the running server
- Writes `manifest.json` with source registry, version, hash

### New API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/registry/install` | Install workspace from jsrepo registry |
| `DELETE` | `/api/registry/:id` | Uninstall (delete workspace directory) |
| `GET` | `/api/registry/available` | Browse available workspaces from configured registries |

### BUN_BE_BUN for Runtime Installation

The compiled sidecar binary can use `BUN_BE_BUN=1` to act as a full Bun CLI, enabling:
- `bun install` for workspace dependencies
- Dynamic TypeScript import without pre-compilation
- Full module resolution (tsconfig paths, node_modules)

### Workspace Registry

A jsrepo registry is a GitHub repo (or jsrepo.com listing) with workspace modules:

```
epicenter-workspaces/
├── jsrepo-manifest.json
├── entries/
│   ├── epicenter.config.ts
│   └── package.json
├── whispering/
│   ├── epicenter.config.ts
│   └── package.json
```

Reference: `packages/ui/jsrepo.config.ts` already uses jsrepo in this monorepo.

---

## Phase 5: TanStack AI Integration

**Goal**: Workspace actions become AI-callable tools via TanStack AI.

> **Topology clarification**: AI streaming lives on the **hub** (`createHubServer`, which already mounts `createAIPlugin` at `/ai/*`), not on the local sidecar. The sidecar does not run AI inference or stream completions — it has no `createAIPlugin`. The SPA sends chat requests directly to the hub's `/ai/chat` SSE endpoint. The sidecar's role in this phase is to expose workspace action descriptors (via `/api/registry`) so the SPA can forward tool schemas to the hub alongside the chat request.

### Dependencies

Add to `packages/server/package.json` (used by the hub):
- `@tanstack/ai` — Core SDK (server-side streaming, tool orchestration)
- `@tanstack/ai-anthropic` and/or `@tanstack/ai-openai` — Provider adapters

Add to `apps/epicenter/package.json` (frontend):
- `@tanstack/ai-svelte` (when available) or vanilla JS adapter

### New Files

**`packages/server/src/ai/workspace-tools.ts`** — Convert workspace actions to TanStack AI tool schemas (used by the hub when building the tool list):

```typescript
import { toolDefinition } from '@tanstack/ai';
import { iterateActions } from '@epicenter/workspace';

export function workspaceActionsToTools(client: AnyWorkspaceClient) {
  const tools = [];
  if (!client.actions) return tools;

  for (const [action, path] of iterateActions(client.actions)) {
    const name = `${client.id}.${path.join('.')}`;
    const def = toolDefinition({
      name,
      description: action.description ?? `${action.type}: ${path.join('.')}`,
      inputSchema: action.input,  // Standard Schema compatible
    });
    tools.push(def.server(async (input) => action.handler(input)));
  }

  return tools;
}
```

This works because:
- `iterateActions()` already walks the action tree and yields `[action, path]` pairs
- Each action has an optional `description` and TypeBox `input` schema
- TypeBox implements Standard Schema, which TanStack AI accepts
- Action handlers are directly callable (closure-based, no context parameter)

Note: `workspaceActionsToTools` and the AI chat route are wired into the **hub** server (via `createAIPlugin` in `packages/server/src/ai/`), not the local sidecar. The hub already imports this plugin unconditionally — see `hub.ts`.

### Frontend AI Chat

A chat component in the workspace view:
- Fetches the workspace descriptor from the sidecar's `/api/registry/:id` to get action schemas
- Sends chat messages (with tool schemas) via SSE to the **hub's** `/ai/chat` endpoint
- Shows tool call execution inline
- Workspace-scoped: only passes that workspace's actions as tools

---

## Security Considerations

**Dynamic code execution**: Workspace modules run in the same Bun process. Mitigations:
- Show trust prompts before installing third-party workspaces
- Only allow installation from known registries initially
- Future: run workspace code in isolated Bun subprocesses

**Port binding**: Bind to `127.0.0.1` only (never `0.0.0.0`). Already the default in `createLocalServer()`.

**CORS**: `createLocalServer()` already restricts to `tauri://localhost`. Add `http://127.0.0.1:*` for sidecar origin.

**Workspace isolation**: Isolated `node_modules` per workspace prevents dependency poisoning across workspaces.

---

## Verification

### Phase 1
1. `bun build --compile apps/epicenter/src-sidecar/main.ts --outfile /tmp/test-sidecar`
2. Run `/tmp/test-sidecar` → prints `PORT:<N>`
3. `curl http://127.0.0.1:<N>/` → returns SPA HTML
4. `bun run tauri dev` → Tauri spawns sidecar, displays SPA in WebView

### Phase 2
1. Place standalone `epicenter.config.ts` in `~/.epicenter/workspaces/test/`
2. Restart sidecar
3. `curl http://127.0.0.1:<N>/api/registry` → lists workspace with JSON Schema
4. Create data via API, restart sidecar, verify data persists in `workspace.yjs`

### Phase 3
1. Open app → workspace list loads from `/api/registry`
2. Navigate to workspace → data loads via WebSocket sync
3. CRUD operations persist through sidecar restart
4. `bun run src-sidecar/main.ts` standalone → SPA works without Tauri

### Phase 4
1. Set up test jsrepo registry (GitHub repo with manifest)
2. Install workspace from registry via UI
3. Verify files downloaded, deps installed, module loads

### Phase 5
1. Open workspace with actions
2. AI chat → SPA fetches action schemas from sidecar `/api/registry/:id`, sends to hub `/ai/chat`
3. Model calls workspace actions as tools; verify streaming SSE responses render in UI
