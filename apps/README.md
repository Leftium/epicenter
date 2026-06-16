# Apps

Each app under `apps/` owns its hosted UI plus, when needed, one reusable daemon mount.

The current center is:

```txt
defineWorkspace()
  app's shared isomorphic definition

open<App>Browser()
<app>()
open<App>Tauri()
  runtime-specific wiring

createWorkspace()
satisfiesWorkspace()
  lower-level primitives for internals, tests, and older app ports
```

## Layout

```
apps/<app>/
├── project.ts       optional `<app>()` daemon mount factory
├── workspace.ts     shared schema, branded IDs, workspace definition, actions
├── src/             SvelteKit app
└── package.json     "exports": { ".": "./workspace.ts", "./project": "./project.ts" }
```

Some apps keep the shared workspace contract under `src/lib/workspace.ts`
instead of the package root. Follow the existing package shape. The important
boundary is the same: shared model in the workspace file, runtime wiring in
`browser.ts`, `project.ts`, or `tauri.ts`.

## Boundaries

`workspace.ts` is the sync contract. It defines table shapes, KV schemas, branded IDs, actions, child-doc layouts, and the app's `defineWorkspace(...)` value. Forking that file means forking sync compatibility.

`project.ts` is the reusable mount factory. It opens the shared workspace with Node-only attachments: Yjs persistence, collaboration, SQLite and Markdown materializers, and daemon-exposed actions.

Browser and desktop code open the same definition with runtime-specific composition. Scripts usually skip Yjs entirely: they read materialized files or SQLite and call daemon actions through `connectDaemonActions`.

## Adding a Daemon Mount

1. Add `apps/<app>/workspace.ts` or `apps/<app>/src/lib/workspace.ts`, following the package's existing layout.
2. Point `package.json` `exports["."]` at the workspace contract file.
3. Add an exported `defineWorkspace({ id, tables, kv, actions })` value. Declare row child docs with `table.docs(...)`.
4. Add `apps/<app>/project.ts` exporting `<app>(opts?)`, a factory that returns `defineSessionMount({ name, open })` (or `defineMount` for a mount that can run signed out).
5. Point `package.json` `exports["./project"]` at `./project.ts`.
6. Run `epicenter daemon up -C <epicenter-root>` and confirm the mount appears in `epicenter list`.
