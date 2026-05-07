---
name: hono
description: Hono patterns for TypeScript API routes, middleware, request and response typing, streaming, WebSockets, and Cloudflare Workers deployment. Use when users mention Hono, honojs, Cloudflare Worker handlers, Hono middleware, or Hono route typing.
metadata:
  author: epicenter
  version: '1.0'
---

# Hono

## Reference Repositories

- [Hono](https://github.com/honojs/hono) - TypeScript web framework for edge runtimes and Cloudflare Workers
- [Cloudflare Docs](https://github.com/cloudflare/cloudflare-docs) - Workers, Durable Objects, WebSockets, KV, R2, and deployment docs

## Upstream Grounding

When Hono route typing, middleware order, context variables, response helpers, streaming, WebSockets, or Cloudflare Worker runtime behavior affects correctness, ask DeepWiki a narrow question against `honojs/hono` or `cloudflare/cloudflare-docs` before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable HTTP basics and repo-local API conventions already visible in the code.

## When to Apply This Skill

Use this pattern when you need to:

- Write or refactor Hono route handlers and middleware.
- Type request params, query values, context variables, or response bodies.
- Adapt Hono handlers to Cloudflare Workers runtime constraints.
- Debug streaming, WebSockets, CORS, auth middleware, or per-route bindings.
