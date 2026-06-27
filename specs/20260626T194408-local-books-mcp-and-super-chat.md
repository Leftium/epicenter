# Local Books MCP server, and the cross-device Super Chat

**Date**: 2026-06-26
**Status**: Draft
**Author**: AI-assisted (Claude)
**Branch**: TBD
**Relates**: [ADR-0072](../docs/adr/0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) (Local Books is standalone, off the mesh), [ADR-0073](../docs/adr/0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (tools speak MCP's data vocabulary; the mesh is the transport MCP lacks), [ADR-0050](../docs/adr/0050-the-inference-contract-is-openai-compatible.md) (the model boundary is OpenAI-compatible, never MCP)

## One-Sentence Test

`apps/local-books` exposes a `local-books mcp` stdio subcommand that, when added to Claude Code via `claude mcp add local-books -- local-books mcp`, lets Claude answer real questions about the local books mirror (it calls a `query` tool) and trigger a re-sync (it calls a `sync` tool), with `recategorize` exposed only when `LOCAL_BOOKS_READ_ONLY` is unset and the host approves a write.

If the MCP server logs anything to stdout, the work is not done (stdout is the JSON-RPC channel; logs go to stderr).
If the server depends on `@epicenter/workspace` or the mesh, the work is not done (Local Books is standalone, ADR-0072).
If `query` is exposed as a writable tool, or `recategorize` runs without the read-only gate, the work is not done.
If the spec's Part B (Super Chat) ships as code in this slice, the work is not done (Part B is design exploration; the buildable slice is Part A only).

## The mental model (read this first)

There are two, and only two, places MCP belongs, plus one place it does not:

1. **The airlock to software you did not write.** MCP is the lingua franca that hosts like Claude Code, Codex, Cursor, and ChatGPT speak. You cannot make them speak Epicenter's mesh protocol, but you can speak MCP to them. So MCP is the border crossing: foreign software on either end means MCP.
   - **Egress** (your tools out to a foreign host): you run an MCP *server*. This is Part A (Local Books).
   - **Ingress** (a foreign tool into your agent): you run an MCP *client*. Out of scope here, noted for completeness.
2. **Inside your own ecosystem, no airlock.** When both ends are your own software, you do not use MCP:
   - Cross-device, app-to-app (your chat calling a tool on your phone's tab-manager): the **mesh** (presence + relay dispatch). This is Part B (Super Chat).
   - In-process (your chat calling a tool in the same runtime): a **direct call**.

The reason the mesh is not "just MCP": MCP-the-protocol needs a stable, addressable server and a point-to-point session. Your cross-device tools run in transient client runtimes (a browser-extension service worker that sleeps and reconnects, reached by `nodeId` through a blind relay, discovered live by *who is online right now*). MCP has no live multi-device presence and cannot hold sessions over the blind relay; the mesh is exactly the transport MCP lacks (ADR-0073). What is shared between the two worlds is the *data shape* of a tool (name + JSON-Schema input + a call), which is why the same `Tool` vocabulary can describe both.

The Super Chat is where the two worlds meet in one tool list: your own tools via the mesh, plus foreign and off-mesh tools (including Local Books) via MCP, flattened into one catalog the model sees.

---

# Part A: Local Books MCP server (buildable now)

## Why Local Books is the ideal first MCP target

Local Books is **standalone and off the mesh by design** (ADR-0072): a Bun CLI that mirrors QuickBooks into a local SQLite file and answers questions against it. Because it is not on the mesh, none of the relay / presence / wire-reshape complexity applies. "Let Claude Code use Local Books" reduces to exactly one thing: **Local Books ships an MCP server.** And its financial data must never transit the plaintext relay (ADR-0004, ADR-0073 invariant 5), so a local stdio MCP server (a subprocess reading the local SQLite) is the *only* correct exposure anyway.

## Current structure (grounded)

- Entry: `src/bin.ts` (Bun shebang) -> `runCli` -> `src/cli.ts` `parseArgs` + a `switch` dispatcher (`src/cli.ts:204-223`).
- `bin` = `local-books` -> `./src/bin.ts` (`package.json`). Compiled via `bun build --compile`.
- Verb cores are **pure `wellcrafted` `Result<T, E>` functions**, not `defineActions` (ADR-0072 left that seam open):
  - `query`: `queryBooks({ dbPath, sql }) -> Result<{ rows, rowCount, truncated }, BooksQueryError>` (`src/books/query.ts:51-73`). Read-only DB open; 1000-row cap.
  - `report`: `fetchReport({ report, start_date?, end_date?, accounting_method? }) -> Result<{ report, data }, ...>` (`src/books/report.ts:61-85`). Live QB call.
  - `recategorize`: `recategorizeExpense({ entity, id, account_id, account_name?, line_id? }) -> Result<RecategorizeResult, ...>` (`src/books/recategorize.ts:110-217`). Write-through; refused when `LOCAL_BOOKS_READ_ONLY=1` (`:127`).
  - `sync`: `syncRealm` / `repairEntities` -> `SyncOutcome` (`src/sync.ts`). FULL vs INCREMENTAL CDC.
  - `status`: connection + sync state from the `_meta` table.
  - `auth`: interactive OAuth (browser). `demo`: offline sample company.
- Data: `dbPath(dataDir, realmId) = <dataDir>/<realmId>/books.db` (`src/paths.ts:29-31`), WAL mode so a read-only reader never blocks the writer.
- Config: `loadConfig()` with precedence CLI > env > `config.json` > defaults (`src/config.ts:141-183`). Token: `credentials.json` (0600), path overridable via `LOCAL_BOOKS_TOKEN_FILE`.
- Tests: `src/books/{query,report,recategorize}.test.ts`, `test/books-cli.test.ts`, `test/grill-e2e.test.ts`, `test/cli-e2e.test.ts`, mock QB at `test/mock-qb-server.ts`.

## Verb -> tool mapping

| Tool | Tier | Core | Notes |
|---|---|---|---|
| `query` | read | `queryBooks` | SQL over the local mirror; 1000-row cap; the workhorse |
| `status` | read | status reader | connection + sync state; cheap, good for "are you connected?" |
| `report` | read | `fetchReport` | live QB financial statements (P&L, BalanceSheet, ...) |
| `sync` | write-ish | `syncRealm` | refresh the mirror (FULL/INCREMENTAL); side-effecting but safe |
| `recategorize` | write | `recategorizeExpense` | **gated**: omit entirely when `LOCAL_BOOKS_READ_ONLY` set; otherwise host must approve |
| ~~`auth`~~ | n/a | - | **excluded**: interactive browser flow, not MCP-suitable |
| ~~`demo`~~ | n/a | - | **excluded**: local-only scaffolding |

The read/write tier is carried as an MCP `Tool._meta["epicenter/tier"]` and, more importantly, enforced by the server: a foreign host gets `recategorize` only when read-only mode is off, and even then the SDK/host approval gate applies (ADR-0073 invariant 1 and 2). Tier is never inferred from MCP's advisory `readOnlyHint`.

## Design decisions

1. **Use the stable SDK, low-level `Server`.** Target `@modelcontextprotocol/sdk@^1.29` (NOT the `@modelcontextprotocol/server@2.x` alpha; note that DeepWiki documents v2 by default, so its samples will not compile against v1). Use the **low-level `Server` + `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)`**, not the high-level `McpServer.registerTool`. Reason: `registerTool` wants a Zod raw shape, but Local Books' inputs are TypeBox, which **is** JSON Schema 2020-12 at runtime. The low-level path lets each tool's `inputSchema` be the TypeBox object passed straight through, validated with `Value.Check`, with zero schema duplication and exact control over the error model.
2. **Do NOT introduce `defineActions` into Local Books.** It stays dependency-light and off `@epicenter/workspace` (ADR-0072). The MCP server maps the existing pure cores directly to tools. The "uniform `defineActions` -> MCP" story is for the *mesh* apps (which get it via `toTool`); a standalone CLI does not need the workspace action machinery to be a clean MCP server. (Open question O1 revisits this if Local Books ever needs to also appear in the Super Chat's hub room.)
3. **Error model follows MCP's two channels.** Unknown tool / invalid arguments -> `throw new McpError(ErrorCode.MethodNotFound | InvalidParams, ...)` (a JSON-RPC protocol error). A tool that ran and failed (bad SQL, QB API error, read-only refusal) -> a normal result with `isError: true` and a `content` text block, so the model can self-correct. This matches the MCP spec exactly and mirrors the ADR-0073 finding that our internal `Result` collapses to `CallToolResult` only at the edge.
4. **stdout is sacred.** The `mcp` subcommand must print nothing to stdout except JSON-RPC. No banners, no `console.log`, no dotenv notices. Route the `wellcrafted/logger` sink to stderr or a file for this subcommand (AGENTS.md already bans `console.*` in library code; this is why it matters acutely here).
5. **Data/auth reach via env passthrough.** The host launches the subprocess; pass `LOCAL_BOOKS_TOKEN_FILE`, `LOCAL_BOOKS_DIR`, `LOCAL_BOOKS_READ_ONLY`, `LOCAL_BOOKS_QB_ENV`, `LOCAL_BOOKS_QB_REALM` through the MCP client config's `env`. The server calls `loadConfig()` exactly as the CLI does, so it reads the same mirror and credentials.

## Sketch

`src/commands/mcp.ts` (new), dispatched from `src/cli.ts` as `case 'mcp': return runMcpServer(args)`:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import Type from 'typebox';
import { Value } from 'typebox/value';
// existing pure cores + config, unchanged:
import { loadConfig } from '../config.js';
import { queryBooks } from '../books/query.js';
import { recategorizeExpense } from '../books/recategorize.js';
// ...

const TIER = 'epicenter/tier';

// One descriptor per tool: the TypeBox input IS the MCP inputSchema.
const TOOLS = [
  {
    name: 'query',
    title: 'Query the books',
    description: 'Run a read-only SQL query against the local QuickBooks mirror.',
    input: Type.Object({ sql: Type.String() }),
    tier: 'query',
    run: (cfg, args) => queryBooks({ dbPath: dbPathFor(cfg), sql: args.sql }),
  },
  // status, report, sync ...
  // recategorize included ONLY when !cfg.readOnly:
];

export async function runMcpServer() {
  const cfg = loadConfig(/* from env */);
  const tools = TOOLS.filter((t) => t.tier !== 'mutation' || !cfg.readOnly);

  const server = new Server(
    { name: 'local-books', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.input,            // TypeBox === JSON Schema, object-typed
      _meta: { [TIER]: t.tier },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    const args = req.params.arguments ?? {};
    if (!Value.Check(tool.input, args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments');
    }
    const { data, error } = await tool.run(cfg, args);   // existing Result core
    if (error) {
      // tool ran and failed -> self-correctable, NOT a protocol error
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  });

  await server.connect(new StdioServerTransport());   // blocks on stdin
}
```

This adds one new file plus one `case` in the dispatcher and one dependency (`@modelcontextprotocol/sdk`). The cores are untouched.

## End-to-end verification (does the architecture hold?)

Three layers, cheapest first:

1. **Automated stdio test** (`test/mcp-server.test.ts`): seed a `books.db` via the existing `demo`/mock-QB fixtures, spawn `bun run src/bin.ts mcp` as a subprocess, write a `tools/list` then a `tools/call` (`query`) JSON-RPC frame to its stdin, assert the framed responses on stdout. Assert: `query` returns rows; an unknown tool yields a JSON-RPC error (not an `isError` result); bad SQL yields `isError: true`; `recategorize` is absent from `tools/list` when `LOCAL_BOOKS_READ_ONLY=1`. This proves the protocol contract without a model.
2. **MCP Inspector** (manual): `npx @modelcontextprotocol/inspector bun run apps/local-books/src/bin.ts mcp`. Confirms `tools/list` renders a form from each TypeBox schema and `tools/call` works. Fastest human check.
3. **Claude Code live** (the real proof): `claude mcp add local-books -- local-books mcp` (or, in dev, `-- bun run /abs/apps/local-books/src/bin.ts mcp`), seed a demo company, then ask Claude Code: "what were my three biggest expenses last month?" (expect a `query` call with a synthesized SQL string and a correct answer) and "re-sync my books" (expect a `sync` call). This is the end-to-end signal that the airlock architecture is right: a foreign host, that knows nothing about Epicenter, drives your tools.

**Success = Part A is the right architecture if**: Claude Code can answer a books question it could not answer before, the server never corrupts the stream, and exposing a new tool later is just one more entry in `TOOLS`. If instead you find yourself wanting the mesh, the relay, or `defineActions` to make this work, the architecture is wrong (and per ADR-0072 it should not be needed).

---

# Part B: the Super Chat (design settled; build gated behind the wedge)

Status: the design is resolved against the code (see [Resolved design](#resolved-design-d1--o1-o4) and [Verdict](#verdict) below). D1, the one new primitive, is prototyped and green on branch `proto/super-chat-d1`. No product code lands in the apps yet; the build is gated behind the same wedge trigger ADR-0073 sets.

## The goal, in the user's words

A chat that knows which Epicenter apps you have used, discovers the ones online *right now* across all your devices, and exposes all their tools, per device, so you can ask one chat to act across your whole ecosystem. "For every user's app, for all their devices, expose all their tools across other apps, per device."

## The problem this runs into

Each app's mesh is its **own room**. A room is addressed `wss://<baseURL>/api/owners/<ownerId>/rooms/<guid>?nodeId=<nodeId>` (`packages/workspace/src/document/transport.ts:20-39`), where the `guid` is the Y.Doc's guid (`connect-doc.ts:73`) and `ownerId` is the user id (`packages/server/src/ownership.ts:70-72`). Presence is **per-room**: an app sees the tools of peers *in the same room*. So opensidian (a notes doc) and tab-manager (a tabs doc) are different rooms and do **not** see each other's tools. Tools are scattered across one room per app per workspace.

## The solution: a per-user hub room

Rooms are partitioned by `ownerId`, and within a user's partition the `guid` is free. So reserve a **well-known guid** (for example `"hub"`). The full address `/api/owners/<userId>/rooms/hub` is automatically per-user (the `ownerId` segment scopes it; two users never cross, `packages/sync/src/room-route.ts:14-19`). Every app instance joins the hub room *in addition to* its data room and publishes its real tool registry there. The Super Chat joins the hub room and runs the existing agent catalog against it.

This needs **no new transport and no relay change**. A presence-only / overlay join already exists: `openCollaboration(ydoc, { actions, ... })` publishes `actions` and surfaces peers regardless of the doc's data, and content docs already do exactly this (`open-collaboration.ts:23-26`, `connect-doc.ts:63,79`). The hub doc carries no durable data; it is purely the live tool directory plus a dispatch path.

### Pseudocode: app side (every mesh app, once at startup)

```ts
// Alongside the app's existing data-doc collaboration (via openToolHub, O1):
const hubDoc = new Y.Doc({ guid: TOOL_HUB_GUID });  // 'tool-hub'; per-user via the ownerId URL segment
const hub = openCollaboration(hubDoc, {
  url: roomWsUrl({ baseURL, ownerId: user.id, guid: TOOL_HUB_GUID, nodeId }),
  openWebSocket: auth.openWebSocket,
  onReconnectSignal: auth.onStateChange,
  actions: app.publishedActions,   // a CURATED subset, not app.actions (O2): names, schemas,
                                   // and dispatched I/O all hit the plaintext relay (ADR-0004)
});
// The app now (a) appears in the hub directory and (b) answers inbound dispatch
// on the hub room with its real handlers, exactly as it does on its data room.
```

### Pseudocode: chat side (the collapsed shape after the dual review)

```ts
const hubDoc = new Y.Doc({ guid: TOOL_HUB_GUID });
const hub = openCollaboration(hubDoc, {
  url: roomWsUrl({ baseURL, ownerId: user.id, guid: TOOL_HUB_GUID, nodeId }),
  openWebSocket: auth.openWebSocket,
  onReconnectSignal: auth.onStateChange,
  actions: {},            // the chat owns no tools; it only consumes peers'
});

// Off-mesh / sensitive tools (Local Books) are a LOCAL MCP source, not on the
// hub. Cache its tools/list as a synthetic peer; route a call to it as tools/call.
const books = await openMcpSource('local-books', ['mcp']);   // -> { peer, dispatch }

// One catalog, one address space: the MCP source is just another peer the
// existing union handles. No mergeCatalogs, no per-source name scheme.
const surface = {
  peers: { list: () => [...hub.peers.list(), books.peer] },
  dispatch: (req) =>
    req.to === books.peer.nodeId ? books.dispatch(req) : hub.dispatch(req),
};
const catalog = createDispatchToolCatalog(surface, { selfNodeId: nodeId });
//   definitions() -> union of every hub peer's tools + Local Books, qualified on collision
//   resolve(call) -> dispatch the BARE action to the owning nodeId (relay or MCP)

createAgentChatState({ agent: { toolCatalog: catalog, /* engine, approval */ } });
// Model boundary stays OpenAI-compatible: tools go to the model as OpenAI tool
// defs (ADR-0050); MCP never touches the model.
```

The catalog -> chat wiring already exists: `createDispatchToolCatalog(surface, { localActions })` is handed to `createAgentChatState({ agent: { toolCatalog } })` (real example: `apps/opensidian/src/lib/session.ts:75-77`, `packages/app-shell/src/agent-chat/agent-chat.svelte.ts:98-109`, loop at `packages/workspace/src/agent/loop.ts:131-140`). The chat is that same wiring pointed at the hub room (plus the MCP source) instead of one app's data room.

### The unification: Local Books serves both Claude Code AND the chat

Local Books is off the mesh, so it is **not** in the hub room. The chat reaches it as a **local MCP client** of the very same `local-books mcp` server built in Part A. So Part A's server has two consumers: Claude Code (foreign host) and your own chat (local host). Build the airlock once; both walk through it. This is the clean consistency: mesh apps -> hub room; sensitive/standalone apps -> local MCP; the chat composes both into one `DispatchSurface` and one catalog.

## Resolved design (D1 + O1-O4)

A 2026-06-26 grill against the code (transport, presence, dispatch, the catalog, two real `session.ts` wirings, and the server ownership middleware) found no blocker, and four corrections to the sketch above. The one genuinely new primitive, the device-qualified catalog (D1), is prototyped and green on branch `proto/super-chat-d1`.

### Drift the grill found (the sketch is right in shape, wrong in four details)

1. `close_tabs@laptop` is not a legal tool name. The catalog's tool name is sent verbatim to the model as an OpenAI `function.name` (`packages/client/src/openai-provider.ts:124`), and that field must match `[a-zA-Z0-9_-]{1,64}`. An `@` is rejected, and one bad name 400s the whole tool list. The separator is `__` and the qualifier is sanitized to `[a-z0-9_-]`, the whole clamped to 64 (D1).
2. `actions: app.actions` publishes too much. The relay reads plaintext (ADR-0004); the hub publishes every tool's name and input schema, and every dispatched call's input and result transit the relay too. An app publishes a curated `publishedActions` subset, not its whole registry (O2: opensidian's `bash_exec` must not be on the hub).
3. Presence carries no device label. A `Peer` is `{ nodeId, connectedAt, actions, agentId }` (`presence-protocol.ts:49-54`), with no human device name. Friendly qualifiers (`close_tabs__macbook`) need a label source, and adding one to presence is a coordinated relay deploy, which Part B forbids. D1 ships a nodeId-fragment qualifier; the friendly-label seam is deferred until a producer exists (O1, dual review).
4. D1 is the headline new primitive, not the only new code. The chat also needs an MCP stdio source (ingress). ADR-0073's spike classified ingress as cheap, standalone, and relay-free, and the dual review then folded it in as one more peer the existing catalog unions (no separate `mergeCatalogs`), so the remaining glue is small, not zero.

### D1: device-qualified dispatch catalog (the crux, prototyped)

Decision: extend `createDispatchToolCatalog`, do not fork a variant. The change is a strict, backward-compatible superset. A single-provider name is unchanged, and a local action still owns the bare name and shadows a remote of the same name (a chat on a device defaults to that device). Only when two or more remote devices advertise the same action does the catalog qualify per device. This also fixes a latent bug in today's single-app rooms: two of your devices in one app's room already collide, and first-peer-wins silently drops one.

One function, `buildRoutes`, builds the emitted-name to route table that both `definitions()` and `resolve()` read, so names and routes never drift:

- Local actions: emitted bare, shadowing any remote of the same name. (unchanged)
- A remote action only one device offers: emitted bare, routed to that nodeId. (unchanged)
- A remote action two or more devices offer: emitted `<action>__<qualifier>` per device, each routed to its nodeId.

The qualified name is a catalog-only display key. The model calls `close_tabs__<fragment>`; `resolve` looks it up in the route table and dispatches the bare action `close_tabs` to that device's nodeId. There is no string parsing on the call path, so a `__` inside an action key can never misroute. Recommended hardening: now that `__` is the catalog's qualification separator, tighten `ACTION_KEY_PATTERN` to forbid `__` in authored action keys (nothing in the repo uses it today), so the human and the model never confuse `foo__bar` the authored tool with `foo` qualified by device `bar`.

Qualifier: the last 6 chars of the nodeId. A nodeId is already `[a-z0-9]{16}` (`shared/id.ts:41`), so the fragment is model-name-safe and unique among a person's handful of devices; on a fragment clash the builder falls back to the full nodeId, which distinguishes any two devices. The prototype carries NO device-label seam: a friendly label (`close_tabs__macbook`) needs a producer, and there is none yet, so per "refuse a field until a live producer exists" the option was dropped. When a friendly label is wanted, the no-relay-change source is a tiny `Y.Map` on the hub doc (`nodeId -> { label, appId }`, written on join, read by the chat); a presence field would be cleaner but is a coordinated relay deploy, so it stays out of Part B.

Prototype: branch `proto/super-chat-d1` (off main, not on PR #2214), two commits. `packages/workspace/src/agent/dispatch-catalog.ts` plus three D1 tests. The device-targeting test proves two simulated devices both surface their `close_tabs` and that resolving the qualified name dispatches `{ to: <thatNodeId>, action: 'close_tabs' }`. 10/10 catalog tests and 23/23 agent tests pass; `bun run --filter '@epicenter/workspace' typecheck` is green.

### O1: hub guid, opt-in, persistence

- Guid: a reserved constant `TOOL_HUB_GUID = 'tool-hub'`, exported from one home so every app and the chat import the same symbol. It cannot collide: real doc guids are 16-char nanoids (`shared/id.ts:41`), the namespaced literal is unlikely to be an app-chosen workspace id, and the `ownerId` URL segment makes the room per-user.
- Opt-in: an app opts in by calling a small `openToolHub(connection, { actions: publishedActions })` helper alongside its data-room wiring, never by default. The "flag" is whether the app calls it, so a new app is off the hub until its tools are audited (O2). The helper opens `openCollaboration` directly against `TOOL_HUB_GUID` with no `attachLocalStorage`, and returns the Disposable the session owns.
- Persistence: none. Presence and dispatch ride the socket, not the doc, so the hub Y.Doc is empty and needs no IndexedDB and no server durability. (A future device-label `Y.Map` would be tiny ephemeral data re-published on connect, still no IndexedDB.)

### O2: privacy audit (which tools may reach the plaintext relay)

The hub does not just publish tool names. It publishes names plus input schemas, and every dispatched call's input and result transit the relay as plaintext (ADR-0004). So the gate is per tool, not per app: a tool may join the hub only when its name, its schema, and its dispatched input and output are no more sensitive than the data the app already syncs through the relay.

- Safe (their data already lives on the relay): tab-manager (`tabs_*`, `saved_tabs_*`, `bookmarks_*`), fuji (`entries_*`), todos (`todos_*`), wiki (`pages_*`, `types_*`), whispering (`recordings_export_markdown`). These leak nothing beyond their synced workspace.
- Curated subset only: opensidian. `files_*` operate inside the vault that already syncs, so they are defensible, but `bash_exec` runs arbitrary shell and pipes its output back, reaching the whole machine (env, secrets, files outside the vault) through the relay. Exclude `bash_exec` from `publishedActions`. Today local-shadows-remote keeps bash in-process, so it has never transited the relay; joining the hub would be the first time, a real new exposure to refuse.
- Never on the hub: Local Books (financial; ADR-0004/0072/0073) and any future app touching secrets, credentials, financial, or health data. They reach the chat through local MCP, exactly as Part A built.

The rule, which is ADR-0073 invariant 5 applied per tool: a tool whose call reaches beyond the app's own synced workspace (arbitrary shell, filesystem outside the workspace, network egress, secrets) does not go on the hub. It goes through a blind transport like MCP.

### O3: lifecycle

The hub collaboration reuses the existing wiring with no new machinery. It takes the same `auth.openWebSocket` and `auth.onStateChange` the data room already uses (`connect-doc.ts:73-77`), so token refresh and reconnect are handled by the same supervisor. Teardown is `hubDoc.destroy()` cascading through `openCollaboration`'s `[Symbol.dispose]`, wired into the app's session dispose next to the data doc. The only addition is one disposable handle the session owns. The cost is one extra socket and relay DO per hub-participating app instance, small for a single user.

### O4: identity for a hosted Super Chat

No new auth mechanism. A hosted Super Chat joins `/api/owners/<userId>/rooms/hub` with the user's bearer through the standard `auth.openWebSocket`. The server enforces the scoping: `require-ownership.ts:35-37` rejects any request whose URL `:ownerId` is not the authenticated user's id (403 OwnerMismatch), so a bearer for user A can never reach user B's hub. The Super Chat is just another mesh client with `actions: {}`.

Keep deferred: a remote or hosted MCP server (as opposed to local stdio) would reintroduce a "which user" problem, because a stdio subprocess inherits the user's local credentials and env with no auth question, while a remote server needs its own per-user auth. Local Books stays local stdio (Part A already is), so this stays deferred.

## New code inventory (the honest scope of Part B)

A two-reviewer pass (see [Dual-review adjudication](#dual-review-adjudication-2026-06-26)) collapsed this list: there is ONE catalog and ONE address space, so MCP folds in as another peer-like source the existing `createDispatchToolCatalog` already unions, and the `mergeCatalogs` combinator is deleted.

1. `dispatch-catalog.ts` device qualification (D1). Prototyped, green.
2. `openToolHub(connection, { actions })` helper. Mechanical: `openCollaboration` against `TOOL_HUB_GUID`, no IDB; returns the Disposable collaboration the session owns. (`open*`, not `attach*`: it opens a resource.)
3. An MCP stdio source: spawn `local-books mcp`, cache its `tools/list` as a synthetic `Peer` (`type` from `_meta["epicenter/tier"]` so a write tool gates), and route a dispatch addressed to it to a `tools/call`. It is presented to D1 as one more entry in `peers.list()` and one more branch in `dispatch`, NOT a second catalog. ADR-0073 spike finding 3 blessed the ingress adapter as standalone and relay-free.
4. The chat surface: compose the hub collaboration and the MCP source into one `DispatchSurface` (`peers` = hub peers plus the MCP peer; `dispatch` routes the MCP nodeId to the stdio client, everything else to the relay), then `createDispatchToolCatalog(composedSurface)`. ~10 lines at the call site, no new primitive. Collision-qualification then handles an MCP-vs-mesh name clash with the same tool-first `__` rule (`query__<booksFragment>`), so no `mcp__`-prefix scheme is needed.
5. There is no "Super Chat app." It is the existing `createAgentChatState` (`apps/opensidian/src/lib/session.ts:44-79`) handed the composed catalog, with `actions: {}`.

None of these touch the transport, the relay, or the model boundary.

## Verdict

Part B is a clean assembly of existing pieces, not a blocker. Every load-bearing claim in the sketch holds against the code: the hub room is the data-room mechanism at a reserved per-user guid, presence and dispatch already do what the chat needs, the catalog-to-chat wiring is unchanged, and the per-user scoping is enforced server-side. The one real new primitive, D1, is built and green. After the dual review below, the rest collapses to: every app calls `openToolHub`, and the chat composes one `DispatchSurface` (hub peers plus the MCP source) into the existing catalog. Build it when a single cross-device chat is something you will use, behind the same wedge trigger ADR-0073 sets. When it lands, graduate the hub-room and device-qualified-catalog decisions into an ADR (or an amendment to ADR-0073).

## Dual-review adjudication (2026-06-26)

Two independent reviewers (an OpenAI Codex run and a Claude subagent) grilled the naming and organization against the code. They converged on the load-bearing calls, which is the signal worth recording:

- Both: keep `__` as the qualification separator (it is the `mcp__server__tool` ecosystem convention, and `-` reads like ordinary words) and keep tool-first order (`close_tabs__phone`): the model picks the capability, then the device. Codex added the reservation: forbid `__` in authored action keys now that the catalog owns it.
- Both: reject a `device` enum parameter in favor of per-device mangled names plus a route table. The parameter would pollute business input schemas, collide with a real `device` field, and force the router to parse input; it also cannot merge two devices that publish different schemas for the same action. Name-mangling keeps each provider's schema and kind verbatim.
- Both: delete `mergeCatalogs`. There is one catalog and one address space; the MCP server is just another source the existing union handles (a synthetic peer in a composed `DispatchSurface`). This is the asymmetric win: the already-built D1 catalog is the whole engine, and the remaining work is populating `peers`.
- Both: `attachHubPresence` is an `open*`, not an `attach*` (it opens a Disposable collaboration), so `openToolHub`. `hubActions` is the curated publication subset, so `publishedActions`. `HUB_ROOM_GUID = 'hub'` is too generic, so `TOOL_HUB_GUID = 'tool-hub'`. "Super Chat" is not a product, it is the existing chat with a wider catalog, so drop the product framing.
- Both flagged `_meta["epicenter/tier"]`: "tier" already names the fast-vs-async resolution tier in `dispatch-catalog.ts`, so it is overloaded. The marker has no consumer yet (it exists only for this future chat), so rename it before PR #2214 merges. Recommended: carry the mesh's own `query`/`mutation` vocabulary so the MCP-source mapping to `Peer.actions[*].type` is identity.
- Split call, adjudicated: Codex would rename `createDispatchToolCatalog` to `createAgentToolCatalog`; the Claude reviewer would keep it. Kept, because with MCP folded in as a composed-surface peer the catalog still only ever reads a `DispatchSurface` and dispatches over it, so the name stays accurate and a rename churns its consumers for no gain. `DispatchSurface` stays for the same reason (it is not mesh-only once an MCP peer composes in, so `MeshToolSurface` would be less accurate).

Applied to the prototype already: dropped the `labelForNode` seam (no producer), qualify by nodeId fragment, fixed a docstring that wrongly claimed locally-shadowed remotes stay reachable. The rest (rename the unbuilt symbols, delete `mergeCatalogs`, the `__` reservation, the `_meta` marker rename) lands with the build.

---

## The unified architecture

```
                    foreign hosts                 your own ecosystem
                 (Claude Code, Codex)          (your devices + apps)
                          |                              |
                       [ MCP ]                        [ mesh ]
                          |                              |
          +---------------+--------------+      hub room (per user)
          |                              |       /api/owners/<you>/rooms/hub
   local-books mcp server         (future) other          |
   (Part A, stdio)                standalone tools    presence + dispatch
          |                                                |
          +----------------- Super Chat catalog -----------+
                          (Part B: mesh tools + local MCP tools,
                           merged, offered to an OpenAI-compatible model)
```

MCP appears at exactly two airlocks (expose yours out; pull theirs in). Everything between your own apps is the mesh. The Super Chat is the merge point.

## Sequencing

1. **Part A, now.** Build `local-books mcp`, verify end-to-end against Claude Code. It has a real consumer today and proves the airlock pattern. This is the entire executable scope of this spec.
2. **Part B, when wanted.** The hub room + Super Chat is a product assembly of existing mesh pieces; the one real new primitive is the device-qualified catalog (D1), now prototyped (`proto/super-chat-d1`). The design is settled (see [Verdict](#verdict)). Start the build only when a single chat across devices is a thing you will use, behind the ADR-0073 wedge trigger, and reuse Part A's MCP server to fold Local Books in.

## Risks / watch-items

- MCP SDK version churn: pin `@modelcontextprotocol/sdk@^1.29`; re-confirm the low-level `Server` import paths against the installed `package.json` `exports` (the high-level docs only cover `McpServer`).
- stdout contamination is the most common stdio-MCP failure; the automated test must assert a clean stream.
- D1 (multi-device name collisions) is the one non-mechanical piece of Part B; do not let the first Super Chat ship with first-wins dedup. Resolved and prototyped (`proto/super-chat-d1`): collision-qualified tool names routed by nodeId, with `__` (not `@`, which the model API rejects) as the separator.

## Definition of done (Part A)

The One-Sentence Test passes, the three-layer verification is green (automated stdio test + Inspector + a live Claude Code session answering a books question and triggering a sync), and adding a future tool is one entry in `TOOLS`. Then delete this spec's Part A section (per the two-state spec lifecycle) and, if Part B is still unbuilt, keep only Part B as the remaining Draft.
