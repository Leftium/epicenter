# Handoff: build the Local Books MCP server (ADR-0073 Part A)

Paste the block below into a fresh Claude Code session at the repo root. It is self-contained.

---

Build a `local-books mcp` stdio MCP server so Claude Code / Codex can query the local
QuickBooks mirror and trigger a re-sync. This is the first real MCP exposure for
Epicenter. Read `specs/20260626T194408-local-books-mcp-and-super-chat.md` first; it is
the full spec and you are executing **Part A only** (the buildable slice). Do NOT build
Part B (the Super Chat / hub room): that is design exploration in the same doc.

WHY THIS SHAPE (already decided, do not re-litigate):
- The rule: MCP is the airlock to software you did not write. Local Books is standalone
  and off the mesh (ADR-0072), and its financial data must never touch the relay
  (ADR-0004, ADR-0073). So the ONLY correct exposure is a LOCAL stdio MCP server: a
  subprocess the host spawns, reading the local SQLite directly. No mesh, no relay, no
  `@epicenter/workspace`, no `defineActions`.
- A `defineAction`/verb maps 1:1 onto an MCP tool because TypeBox IS JSON Schema at
  runtime, so an input schema is the `Tool.inputSchema` verbatim. There are no "huge
  conversions."

GROUND TRUTH (verified):
- CLI: `apps/local-books/src/bin.ts` -> `runCli` -> `src/cli.ts` `parseArgs` + a `switch`
  dispatcher at `src/cli.ts:204-223`. `bin` = `local-books` -> `./src/bin.ts` (Bun shebang).
- Verb cores are pure `wellcrafted` `Result<T,E>` functions (NOT `defineActions`):
  - `queryBooks({ dbPath, sql })` -> `{ rows, rowCount, truncated }`, read-only, 1000-row
    cap (`src/books/query.ts:51-73`).
  - `fetchReport({ report, start_date?, end_date?, accounting_method? })` (`src/books/report.ts:61-85`).
  - `recategorizeExpense({ entity, id, account_id, account_name?, line_id? })`, refused when
    `LOCAL_BOOKS_READ_ONLY=1` (`src/books/recategorize.ts:110-217`, gate at :127).
  - `syncRealm` -> `SyncOutcome` (`src/sync.ts`); a status reader from the `_meta` table.
- Data: `dbPath(dataDir, realmId) = <dataDir>/<realmId>/books.db` (`src/paths.ts:29-31`),
  WAL so a read-only reader never blocks the writer.
- Config: `loadConfig()` precedence CLI > env > config.json > defaults (`src/config.ts:141-183`).
  Token: `credentials.json`, path via `LOCAL_BOOKS_TOKEN_FILE`.
- Tests live in `apps/local-books/test/` and `src/books/*.test.ts`; mock QB at
  `test/mock-qb-server.ts`; `demo` seeds an offline sample company.

SCOPE (tools to expose):
- `query` (read), `status` (read), `report` (read), `sync` (write-ish, safe).
- `recategorize` (write): expose ONLY when `LOCAL_BOOKS_READ_ONLY` is unset.
- EXCLUDE `auth` (interactive browser) and `demo` (local scaffolding).
- Carry the read/write tier as `Tool._meta["epicenter/tier"]` and enforce it server-side
  (drop mutations under read-only mode). Never read MCP's advisory readOnlyHint.

HOW TO BUILD IT (decided):
- Add dependency `@modelcontextprotocol/sdk@^1.29` (the STABLE package). Do NOT use
  `@modelcontextprotocol/server@2.x` (alpha); DeepWiki documents v2, so ignore DeepWiki
  code samples and follow the stable v1 shapes.
- Use the LOW-LEVEL `Server` + `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)`
  from `@modelcontextprotocol/sdk/server/index.js` and `.../types.js`, with
  `StdioServerTransport` from `.../server/stdio.js`. NOT the high-level `McpServer.registerTool`
  (it wants a Zod raw shape; the low-level path lets each tool's `inputSchema` be the TypeBox
  object passed straight through, validated with `Value.Check`). Confirm the import paths
  against the installed package's `exports` after `bun add`.
- Error model (MCP's two channels): unknown tool / invalid args -> `throw new McpError(...)`
  (JSON-RPC protocol error). A tool that ran and failed (bad SQL, QB error, read-only refusal)
  -> a normal result `{ content: [{type:'text', text}], isError: true }` so the model self-corrects.
- New file `src/commands/mcp.ts` exporting `runMcpServer()`; add `case 'mcp': return runMcpServer(args)`
  to the `src/cli.ts` dispatcher. Map the existing pure cores directly; do not touch them.
- CRITICAL Bun/stdio gotcha: stdout is the JSON-RPC channel. The `mcp` subcommand must print
  NOTHING to stdout except protocol frames. No `console.log`, no banners, no dotenv notices;
  route the `wellcrafted/logger` sink to stderr or a file for this path. A single stray stdout
  byte corrupts framing.
- Use the sketch in the spec's "Sketch" section as the starting shape.

VERIFY END-TO-END (all three):
1. Automated: `apps/local-books/test/mcp-server.test.ts` -> seed a books.db via demo/mock-QB,
   spawn `bun run src/bin.ts mcp`, send `tools/list` then `tools/call` (`query`) JSON-RPC over
   stdin, assert framed stdout. Assert: query returns rows; unknown tool -> JSON-RPC error
   (not isError); bad SQL -> isError:true; `recategorize` absent from tools/list when
   `LOCAL_BOOKS_READ_ONLY=1`; stdout carries ONLY JSON-RPC.
2. Inspector: `npx @modelcontextprotocol/inspector bun run apps/local-books/src/bin.ts mcp`.
3. Live: `claude mcp add local-books -- bun run <abs>/apps/local-books/src/bin.ts mcp` (pass
   `--env LOCAL_BOOKS_TOKEN_FILE=...` / `LOCAL_BOOKS_DIR=...` as needed), seed a demo company,
   then ask Claude Code "what were my three biggest expenses last month?" (expect a `query`
   tool call + correct answer) and "re-sync my books" (expect a `sync` call).

DONE = the One-Sentence Test in the spec passes, the three checks are green, and adding a
future tool is one more entry in the tool table. Then update the spec per its two-state
lifecycle (delete Part A, keep Part B if still unbuilt). Run `bun test` in apps/local-books
and the repo typecheck/quality gate before handing back. Commit on a feature branch; do not
push or open a PR unless asked. Stage specific files only (no `git add -A`).

DO NOT: add `@epicenter/workspace`/mesh/relay; expose `query` as writable; run `recategorize`
without the read-only gate; log to stdout; build the Super Chat (Part B).

ENVIRONMENT / AUTH (important for testing):
- `query` and `status` work on the offline `demo` company with ZERO QuickBooks auth:
  seed it (`bun run src/bin.ts demo`), then fully build + test the read path, the
  Inspector, and a live Claude Code `query` with no credentials.
- `sync`, `report`, `recategorize` hit live QuickBooks, which needs a prior one-time
  `local-books auth` (interactive browser OAuth; token saved to a 0600 `credentials.json`).
  For AUTOMATED tests, exercise these against the existing mock QB server
  (`test/mock-qb-server.ts`), NOT live QB.
- Do NOT attempt `local-books auth` from the agent session: it needs a browser and this is
  a headless worktree. If a live sync/report test against real QB is wanted, the USER runs
  `local-books auth` once from a native GUI terminal first. Build and verify everything else
  (query/status on demo, mock-QB tests, Inspector) without it.
- Adding the SDK dep: match how `apps/local-books/package.json` already declares deps
  (`ms`, `oauth4webapi`, `typebox`, `wellcrafted`); add `@modelcontextprotocol/sdk`
  consistently with the repo's catalog convention.
- Ignore ADR-0073's mesh wire-reshape and the `spike/mcp-vocab-reshape` branch: both are
  irrelevant to Part A (Local Books is off the mesh).
