# Plan: Remove elysia-mcp and Implement Custom MCP Integration

## Context

Currently using `elysia-mcp` package to integrate MCP with our Elysia server. The package:
- Creates an `McpServer` instance internally
- Uses `StreamableHTTPServerTransport` (their own Elysia-adapted version)
- Exposes a `setupServer` callback that receives `McpServer`
- We then use `mcpServer.server` to access the low-level `Server` for JSON Schema support

**Problem**: The elysia-mcp package adds unnecessary abstraction. We already have our own tool registry and handlers in `mcp.ts`. We can use the MCP SDK primitives directly.

## What elysia-mcp Does

From examining the source:

1. **Creates `McpServer`** with provided serverInfo and capabilities
2. **Creates `ElysiaStreamingHttpTransport`** (their custom transport for Elysia)
3. **Registers routes** at `basePath` (default `/mcp`):
   - `GET /mcp` - SSE stream for responses
   - `POST /mcp` - Receive JSON-RPC requests
   - `DELETE /mcp` - Session termination
   - `ALL /mcp/*` - Catch-all for sub-paths
4. **Handles session management** via `Mcp-Session-Id` header
5. **Calls `setupServer`** callback with the `McpServer` instance

## MCP SDK Primitives Available

From the `@modelcontextprotocol/sdk`:

### Low-Level `Server` Class
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server(
  { name: 'my-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Register handlers with raw JSON schemas
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ ... }));
```

### Transport Options
```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
```

### `StreamableHTTPServerTransport` Usage
```typescript
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  enableJsonResponse: true, // or false for SSE
});

await server.connect(transport);

// In route handler:
await transport.handleRequest(req, res, req.body);
```

## Implementation Plan

### 1. Remove elysia-mcp dependency
- [ ] Remove from package.json
- [ ] Remove import from server.ts

### 2. Create custom MCP route handler
- [ ] Create `StreamableHTTPServerTransport` directly
- [ ] Register Elysia routes for `/mcp` (GET, POST, DELETE)
- [ ] Handle session management via headers

### 3. Update server.ts
- [ ] Initialize `Server` directly (not `McpServer`)
- [ ] Connect to transport
- [ ] Call `setupMcpTools` with the server instance

### 4. Update mcp.ts
- [ ] Change `setupMcpTools` to accept `Server` instead of `McpServer`
- [ ] Remove `mcpServer.server` access (no longer needed)

## Code Changes

### server.ts (simplified)

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Create MCP server with low-level Server class
const mcpServer = new Server(
  { name: config.id, version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Build tool registry and setup handlers
const toolRegistry = await buildMcpToolRegistry(client);
setupMcpTools(mcpServer, toolRegistry);

// Session storage for transports
const sessions = new Map<string, StreamableHTTPServerTransport>();

const app = new Elysia()
  // ... openapi plugin ...

  // MCP endpoint - POST for requests
  .post('/mcp', async ({ request, set }) => {
    const sessionId = request.headers.get('mcp-session-id');

    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      // Create new transport for new session
      const newSessionId = crypto.randomUUID();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableJsonResponse: true,
      });
      sessions.set(newSessionId, transport);
      await mcpServer.connect(transport);
      set.headers['mcp-session-id'] = newSessionId;
    }

    // Handle the request
    const body = await request.json();
    return transport.handleRequest(request, ???, body);
  })

  // MCP endpoint - GET for SSE stream
  .get('/mcp', async ({ request }) => {
    // Handle SSE streaming
  })

  // MCP endpoint - DELETE for session termination
  .delete('/mcp', async ({ request }) => {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (transport) {
        await transport.close();
        sessions.delete(sessionId);
      }
    }
    return { ok: true };
  });
```

### mcp.ts changes

```typescript
// Change from:
export function setupMcpTools(mcpServer: McpServer, ...): void {
  const server: Server = mcpServer.server;
  // ...
}

// To:
export function setupMcpTools(server: Server, ...): void {
  // Direct usage, no .server access needed
  // ...
}
```

## Key Considerations

1. **Session Management**: Need to handle `Mcp-Session-Id` header ourselves
2. **Transport Lifecycle**: Need to manage transport creation and cleanup
3. **SSE vs JSON**: Decide whether to support SSE streaming or just JSON responses
4. **Response Format**: `StreamableHTTPServerTransport.handleRequest` returns different types based on mode

## Questions to Resolve

1. Do we need SSE streaming, or is JSON-only sufficient?
2. How does `handleRequest` work with Elysia's context? The SDK examples use Express.
3. Should we create a reusable Elysia plugin or inline the logic?

## Benefits of Custom Implementation

1. **No extra dependency**: One less package to maintain
2. **Full control**: Can customize session handling, logging, etc.
3. **Simpler**: No McpServer wrapper, direct Server usage
4. **Better types**: No type mismatches from elysia-mcp

## Risks

1. **More code to maintain**: We own the transport integration
2. **Potential bugs**: elysia-mcp may have handled edge cases we miss
3. **MCP protocol changes**: Need to update our implementation if SDK changes

## Tasks

- [ ] Study `StreamableHTTPServerTransport` API more deeply
- [ ] Prototype the route handlers in isolation
- [ ] Test with MCP Inspector
- [ ] Remove elysia-mcp and switch to custom implementation
- [ ] Update mcp.ts to use Server directly
