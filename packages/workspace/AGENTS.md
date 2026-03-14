# Epicenter Package

Core library shared across apps.

## Key Points

- Pure TypeScript library; no framework dependencies
- All functions return `Result<T, E>` types
- Use Bun for everything (see below)

## Content Model

`handle` is the canonical interface for document content. It reads/writes through the timeline (`Y.Array('timeline')`), supports text, richtext, and sheet modes. Use `handle.asText()`, `handle.asRichText()`, or `handle.asSheet()` for mode-aware editor binding with automatic conversion—they return `Result` types. Use `handle.read()`/`handle.write()` for simple string I/O. Direct `handle.ydoc` access is an escape hatch—use the handle methods instead.

## Bun Usage

Default to Bun instead of Node.js:

- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of `jest` or `vitest`
- `bun build` instead of `webpack` or `esbuild`
- `bun install` instead of `npm/yarn/pnpm install`
- `bun run <script>` instead of `npm/yarn/pnpm run`
- Bun auto-loads `.env`; don't use dotenv

## Bun APIs

- For Elysia servers, use `app.listen()` instead of `Bun.serve()` (required for WebSocket support)
- For raw HTTP servers without Elysia, use `Bun.serve()` (supports WebSockets, HTTPS, routes). Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- `Bun.file` over `node:fs` readFile/writeFile
- `Bun.$\`ls\`` instead of `execa`

## Testing

```ts
import { test, expect } from "bun:test";

test("example", () => {
  expect(1).toBe(1);
});
```

## Specs and Docs

- Package-specific specs: `./specs/`
- Package-specific docs: `./docs/articles/`
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.
