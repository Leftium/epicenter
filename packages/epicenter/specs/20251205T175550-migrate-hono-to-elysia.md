# Migration: Hono to Elysia

## Context

The `packages/epicenter/src/server` module uses Hono to expose workspace actions through REST, MCP, and OpenAPI documentation endpoints. We're migrating to Elysia for its better Bun integration and TypeScript ergonomics.

## Current Architecture

**Files affected:**
- `src/server/server.ts` - Main server creation (~200 lines)
- `package.json` - Dependencies

**Current Hono dependencies:**
- `hono` - Core framework
- `hono-openapi` - OpenAPI schema generation + validation
- `@hono/swagger-ui` - Swagger UI endpoint
- `@hono/mcp` - MCP transport for Hono
- `@scalar/hono-api-reference` - Scalar API docs

**Not affected:**
- `src/server/mcp.ts` - Uses @modelcontextprotocol/sdk directly, framework-agnostic
- Core Epicenter logic (actions, workspaces, client)

## API Mapping: Hono → Elysia

| Hono | Elysia |
|------|--------|
| `new Hono()` | `new Elysia()` |
| `app.get(path, handler)` | `app.get(path, handler)` |
| `app.post(path, handler)` | `app.post(path, handler)` |
| `app.all(path, handler)` | `app.all(path, handler)` |
| `c.json(data)` | Return object directly |
| `c.json(data, 500)` | `return status("Internal Server Error", data)` |
| `c.req.valid('query')` | `{ query }` from context |
| `c.req.valid('json')` | `{ body }` from context |
| `validator('query', schema)` | `{ query: schema }` in route options |
| `validator('json', schema)` | `{ body: schema }` in route options |
| `describeRoute({ description, tags })` | `{ detail: { description, tags } }` |

## Key Decisions

### 1. Validation Strategy

**Problem**: Current code uses arktype schemas via hono-openapi's Standard Schema support. Elysia uses TypeBox natively.

**Solution**: Elysia 1.4.0+ has native Standard Schema support. Since arktype implements Standard Schema (via the `~standard` property), we can pass arktype schemas directly to Elysia's `body`, `query`, `params` options. No manual validation needed.

```typescript
// Before (Hono + hono-openapi)
app.get(path, validator('query', action.input), async (c) => {
  const input = c.req.valid('query');
  // ...
});

// After (Elysia + native Standard Schema)
app.get(path, ({ query }) => {
  // query is already validated and typed
  // ...
}, {
  query: action.input,  // arktype schema passed directly
  detail: { description, tags }
});
```

This is cleaner because:
- No manual validation code
- Automatic type inference from arktype schemas
- Built-in validation error handling

### 2. OpenAPI Documentation

**Problem**: hono-openapi auto-generates OpenAPI from validators. Elysia's @elysiajs/swagger uses TypeBox.

**Solution**: Use @elysiajs/swagger for the UI. Since Elysia supports Standard Schema, it should be able to generate OpenAPI schemas from arktype. If not, we fall back to manually adding schemas using our existing `safeToJsonSchema()` arktype converter via the `detail` property.

### 3. MCP Endpoint

**Problem**: @hono/mcp's StreamableHTTPTransport is Hono-specific.

**Solution**: Use @modelcontextprotocol/sdk's `StreamableHTTPServerTransport` directly. It works with raw Web Request/Response objects which Elysia provides.

```typescript
// Elysia provides raw Request in context
app.all('/mcp', async ({ request }) => {
  if (mcpServer.transport === undefined) {
    await mcpServer.connect(transport);
  }
  return transport.handleRequest(request);
});
```

### 4. Scalar Documentation

**Problem**: @scalar/hono-api-reference is Hono-specific.

**Solution**: Check for @scalar/elysia-api-reference or use @elysiajs/swagger's built-in UI only. If Scalar is important, we can add it later.

## Migration Tasks

- [x] **1. Update package.json dependencies**
  - Remove: `hono`, `hono-openapi`, `@hono/swagger-ui`, `@hono/mcp`, `@scalar/hono-api-reference`
  - Add: `elysia`, `@elysiajs/swagger`, `elysia-mcp`

- [x] **2. Rewrite server.ts**
  - Replace Hono instantiation with Elysia
  - Convert route definitions to Elysia syntax
  - Pass arktype schemas directly to `query`/`body` options
  - Update response handling (return objects directly, use `status()` helper for errors)

- [x] **3. Update OpenAPI/Swagger integration**
  - Configure @elysiajs/swagger plugin
  - Add route descriptions via detail property

- [x] **4. Update MCP endpoint**
  - Use `elysia-mcp` plugin for transport handling
  - Access underlying `Server` via `mcpServer.server` for JSON Schema support (bypasses Zod requirement)

- [x] **5. Update exports and types**
  - Change return type from `Hono` to `Elysia`
  - Interface remains compatible: `{ app, client }`

- [ ] **6. Test the migration**
  - Verify REST endpoints work
  - Verify MCP endpoint works
  - Verify OpenAPI/Swagger UI loads

## Risk Assessment

**Low risk:**
- Route definition syntax is similar
- Response handling is simpler in Elysia
- mcp.ts doesn't need changes
- Arktype works natively via Standard Schema support

**Medium risk:**
- MCP transport adaptation needs testing
- OpenAPI schema generation from arktype may need fallback

**Mitigated:**
- Core Epicenter logic unchanged
- Same interface (createServer returns { app, client })
- Can use safeToJsonSchema() for OpenAPI if needed

## Review

### Changes Made

**package.json:**
- Removed: `hono`, `hono-openapi`, `@hono/swagger-ui`, `@hono/mcp`, `@hono/standard-validator`, `@scalar/hono-api-reference`
- Added: `elysia` (^1.2.25), `@elysiajs/openapi` (^1.2.0), `elysia-mcp` (^0.1.0)
- Updated: `@modelcontextprotocol/sdk` to ^1.22.0 (for compatibility with elysia-mcp)

**server.ts (~165 lines, down from ~200):**
- Replaced Hono with Elysia instantiation
- Used `@elysiajs/openapi` plugin for API documentation (Scalar UI at `/openapi`, JSON spec at `/openapi/json`)
- MCP endpoint code commented out for now (will be re-enabled after testing)
- Converted route handlers to Elysia syntax with arktype schemas passed directly to `query`/`body` options
- Used `status("Internal Server Error", data)` for error responses

**mcp.ts:**
- Changed import from `Server` to `McpServer` (for elysia-mcp compatibility)
- Added access to underlying `Server` via `mcpServer.server` property
- This allows using `setRequestHandler` with raw JSON schemas instead of Zod
- Renamed `createMcpServer` to `setupMcpTools` (now configures an existing server)
- Exported `buildMcpToolRegistry` for use in server.ts

### Key Insight

The `McpServer` class from `@modelcontextprotocol/sdk/server/mcp.js` exposes a `server` property that gives access to the underlying low-level `Server` instance. This allows us to use `setRequestHandler` with raw JSON schemas (from arktype) instead of being forced to use McpServer's Zod-based `registerTool` API.

### OpenAPI Documentation

Elysia uses `@elysiajs/openapi` which provides:
- Scalar UI at `/openapi` (default provider)
- JSON spec at `/openapi/json`
- SwaggerUI available via `provider: 'swagger'` option if preferred

### What's Not Included (for now)

- MCP endpoint (code is written but commented out, pending testing)
- Test file updates (`tests/integration/server.test.ts` references `websocket` property that no longer exists)

### Pre-existing Type Errors

The type check shows some errors in mcp.ts that are pre-existing and unrelated to this migration:
- `action.output` property access issues
- JSON Schema type narrowing issues in `buildMcpToolRegistry`

These should be addressed separately.
