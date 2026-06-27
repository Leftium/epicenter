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

# Part B: the Super Chat (design exploration, not this slice)

## The goal, in the user's words

A chat that knows which Epicenter apps you have used, discovers the ones online *right now* across all your devices, and exposes all their tools, per device, so you can ask one chat to act across your whole ecosystem. "For every user's app, for all their devices, expose all their tools across other apps, per device."

## The problem this runs into

Each app's mesh is its **own room**. A room is addressed `wss://<baseURL>/api/owners/<ownerId>/rooms/<guid>?nodeId=<nodeId>` (`packages/workspace/src/document/transport.ts:20-39`), where the `guid` is the Y.Doc's guid (`connect-doc.ts:73`) and `ownerId` is the user id (`packages/server/src/ownership.ts:70-72`). Presence is **per-room**: an app sees the tools of peers *in the same room*. So opensidian (a notes doc) and tab-manager (a tabs doc) are different rooms and do **not** see each other's tools. Tools are scattered across one room per app per workspace.

## The solution: a per-user hub room

Rooms are partitioned by `ownerId`, and within a user's partition the `guid` is free. So reserve a **well-known guid** (for example `"hub"`). The full address `/api/owners/<userId>/rooms/hub` is automatically per-user (the `ownerId` segment scopes it; two users never cross, `packages/sync/src/room-route.ts:14-19`). Every app instance joins the hub room *in addition to* its data room and publishes its real tool registry there. The Super Chat joins the hub room and runs the existing agent catalog against it.

This needs **no new transport and no relay change**. A presence-only / overlay join already exists: `openCollaboration(ydoc, { actions, ... })` publishes `actions` and surfaces peers regardless of the doc's data, and content docs already do exactly this (`open-collaboration.ts:23-26`, `connect-doc.ts:63,79`). The hub doc carries no durable data; it is purely the live tool directory plus a dispatch path.

### Pseudocode: app side (every mesh app, once at startup)

```ts
// Alongside the app's existing data-doc collaboration:
const hubDoc = new Y.Doc({ guid: 'hub' });          // per-user via the ownerId URL segment
const hub = openCollaboration(hubDoc, {
  url: roomWsUrl({ baseURL, ownerId: user.id, guid: 'hub', nodeId }),
  openWebSocket: auth.openWebSocket,
  onReconnectSignal: auth.onStateChange,
  actions: app.actions,   // publish THIS app's REAL tools: discoverable AND dispatchable
});
// The app now (a) appears in the hub directory and (b) answers inbound dispatch
// on the hub room with its real handlers, exactly as it does on its data room.
```

### Pseudocode: Super Chat side

```ts
const hubDoc = new Y.Doc({ guid: 'hub' });
const hub = openCollaboration(hubDoc, {
  url: roomWsUrl({ baseURL, ownerId: user.id, guid: 'hub', nodeId }),
  openWebSocket: auth.openWebSocket,
  onReconnectSignal: auth.onStateChange,
  actions: {},            // the chat owns no tools; it only consumes peers'
});

// Every online app's tools across all this user's devices, live:
const meshCatalog = createDispatchToolCatalog(hub, { selfNodeId: nodeId });
//   definitions() -> union of every hub peer's tools
//   resolve(call) -> dispatch to the owning peer by nodeId (existing path)

// Off-mesh / sensitive tools (Local Books) come in via MCP, NOT the hub room:
const localBooks = await connectMcpStdio('local-books', ['mcp']); // thin MCP-client -> ToolCatalog
const catalog = mergeCatalogs([meshCatalog, localBooks]);

createAgentChatState({ agent: { toolCatalog: catalog, /* engine, approval */ } });
// Model boundary stays OpenAI-compatible: tools go to the model as OpenAI tool
// defs (ADR-0050); MCP never touches the model.
```

The catalog -> chat wiring already exists: `createDispatchToolCatalog(collaboration, { localActions })` is handed to `createAgentChatState({ agent: { toolCatalog } })` (real example: `apps/opensidian/src/lib/session.ts:75-77`, `packages/app-shell/src/agent-chat/agent-chat.svelte.ts:98-109`, loop at `packages/workspace/src/agent/loop.ts:131-140`). The Super Chat is that same wiring pointed at the hub room instead of one app's data room.

### The unification: Local Books serves both Claude Code AND the Super Chat

Local Books is off the mesh, so it is **not** in the hub room. The Super Chat reaches it as a **local MCP client** of the very same `local-books mcp` server built in Part A. So Part A's server has two consumers: Claude Code (foreign host) and your own Super Chat (local host). Build the airlock once; both walk through it. This is the clean consistency: mesh apps -> hub room; sensitive/standalone apps -> local MCP; the Super Chat merges all sources into one catalog.

## Design decisions and open questions for Part B

- **D1 (cross-device disambiguation):** Two devices each running tab-manager both publish `close_tabs`. `createDispatchToolCatalog` currently dedupes by name, first peer wins (`dispatch-catalog.ts`), which silently drops one device and removes the ability to target a device. The Super Chat needs device-qualified tools (for example `close_tabs@laptop`) or a catalog variant that exposes per-peer tools. **This is a required change to the catalog for multi-device.**
- **O1 (hub room guid + opt-in):** pick the reserved guid and a convention for which apps publish to the hub (a flag in the app's collaboration setup). Decide whether the hub doc needs any persistence (probably not; a fresh empty Y.Doc per session).
- **O2 (privacy):** the hub room publishes tool names + input schemas to the plaintext-reading relay (ADR-0004). Fine for tab-manager; **never** for Local Books (financial), which is why it stays off the mesh and is reached via local MCP. Audit which apps' tool *names* are sensitive before they join the hub.
- **O3 (lifecycle):** the hub collaboration lives for the app's lifetime; reuse the existing reconnect/auth signal wiring. No new lifecycle machinery.
- **O4 (identity for hosted Super Chat):** if the Super Chat is a web app rather than one of your installed apps, it still joins `/api/owners/<userId>/rooms/hub` with the user's bearer; "which URL is the client connected from" is answered by the standard room URL + auth, not a new mechanism. A *remote/hosted* MCP server (as opposed to local stdio) would reintroduce the "which user" auth problem; defer it.

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
2. **Part B, when wanted.** The hub room + Super Chat is a product assembly of existing mesh pieces; the one real new primitive is the device-qualified catalog (D1). Start it only when a single chat across devices is a thing you will use, and reuse Part A's MCP server to fold Local Books in.

## Risks / watch-items

- MCP SDK version churn: pin `@modelcontextprotocol/sdk@^1.29`; re-confirm the low-level `Server` import paths against the installed `package.json` `exports` (the high-level docs only cover `McpServer`).
- stdout contamination is the most common stdio-MCP failure; the automated test must assert a clean stream.
- D1 (multi-device name collisions) is the one non-mechanical piece of Part B; do not let the first Super Chat ship with first-wins dedup.

## Definition of done (Part A)

The One-Sentence Test passes, the three-layer verification is green (automated stdio test + Inspector + a live Claude Code session answering a books question and triggering a sync), and adding a future tool is one entry in `TOOLS`. Then delete this spec's Part A section (per the two-state spec lifecycle) and, if Part B is still unbuilt, keep only Part B as the remaining Draft.
