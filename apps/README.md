# Apps

Each app under `apps/` owns its hosted UI plus, when needed, one local daemon extension.

The current center is:

```txt
createWorkspace()
  low-level package primitive

create<App>Workspace()
  app's shared isomorphic model

open<App>Browser()
open<App>Daemon()
open<App>Tauri()
  runtime-specific wiring

defineWorkspace()
  preserves the inferred bundle shape after composition
```

## Layout

```
apps/<app>/
├── daemon.ts        optional `open<App>Daemon(ctx)` runtime
├── workspace.ts     shared schema, branded IDs, create<App>Workspace, actions
├── src/             SvelteKit app
└── package.json     "exports": { ".": "./workspace.ts" }
```

Some apps keep the shared workspace contract under `src/lib/workspace.ts`
instead of the package root. Follow the existing package shape. The important
boundary is the same: shared model in the workspace file, runtime wiring in
`browser.ts`, `daemon.ts`, or `tauri.ts`.

## Boundaries

`workspace.ts` is the sync contract. It defines table shapes, KV schemas, branded IDs, actions, deterministic child-doc ids, and `create<App>Workspace()`. Forking that file means forking sync compatibility.

`daemon.ts` is the local extension. It opens the shared workspace with Node-only attachments: Yjs persistence, collaboration, SQLite and Markdown materializers, and daemon-exposed actions.

Browser and desktop code compose runtime-only attachments around the same `create<App>Workspace(...)` model. Scripts usually skip Yjs entirely: they read materialized files or SQLite and call daemon actions through `connectDaemonActions`.

## Adding a Daemon App

1. Add `apps/<app>/workspace.ts` or `apps/<app>/src/lib/workspace.ts`, following the package's existing layout.
2. Point `package.json` `exports["."]` at the workspace contract file.
3. Add `create<App>Workspace()` and return `defineWorkspace({ ...workspace, actions, ...sharedChildDocs })`.
4. Add `apps/<app>/daemon.ts` exporting `open<App>Daemon(ctx)` as a free factory. The project's `epicenter.config.ts` exports a mount with `defineMount({ open: openXDaemon })` when explicit typing is useful, or registers the opener through the current project config shape for multi-mount projects.
5. Run `epicenter daemon up -C <project>` and confirm the route appears in `epicenter list`.
