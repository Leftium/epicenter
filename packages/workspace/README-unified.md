# Unified Workspace Architecture

> **Historical note.** This file once described a "workspaces that aggregate
> workspaces" architecture built on `createWorkspace({ dependencies: [...] })`
> and an `@epicenter/epicenter` package. That model is gone. There is one
> primitive today: `defineDocument(builder)`. For inter-workspace composition,
> import one workspace's actions from another and call them — regular
> JavaScript modules, no special dependency graph.

See [`README.md`](./README.md) for the current API, and `packages/workspace/src/document/define-document.ts` for the primitive. For the canonical wiring of a real app, see `apps/tab-manager/src/lib/client.ts`.
