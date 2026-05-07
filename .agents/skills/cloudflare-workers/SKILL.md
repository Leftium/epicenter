---
name: cloudflare-workers
description: Cloudflare Workers patterns for Worker runtime APIs, Durable Objects, KV, R2, D1, Queues, WebSockets, streaming responses, bindings, wrangler configuration, and deployment limits. Use when users mention Cloudflare Workers, Durable Objects, KV, R2, D1, Queues, wrangler, or edge runtime behavior.
metadata:
  author: epicenter
  version: '1.0'
---

# Cloudflare Workers

## Reference Repositories

- [Cloudflare Docs](https://github.com/cloudflare/cloudflare-docs) - Workers, Durable Objects, KV, R2, D1, Queues, WebSockets, bindings, and deployment docs
- [Hono](https://github.com/honojs/hono) - TypeScript web framework commonly used on Workers

## Upstream Grounding

When Worker runtime behavior, bindings, Durable Objects, WebSockets, streaming, cache APIs, service bindings, compatibility dates, limits, or wrangler configuration affect correctness, ask DeepWiki a narrow question against `cloudflare/cloudflare-docs` before relying on memory. Use `honojs/hono` as the grounding repo when the question is about Hono on Workers.

Verify decisive details against local generated Worker types, source, or official Cloudflare docs before changing code. Skip DeepWiki for stable Web API basics and repo-local deployment patterns already visible in the code.

## When to Apply This Skill

Use this pattern when you need to:

- Work on `apps/api` Worker code, bindings, or `wrangler` configuration.
- Implement or debug Durable Objects, KV, R2, D1, Queues, or WebSockets.
- Handle streaming responses, SSE, CORS, cache behavior, or request lifecycle limits.
- Check Cloudflare-specific runtime behavior or deployment constraints.
