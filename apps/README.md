# Apps

Each app under `apps/` is a workspace package that ships one schema and a small set of runtime recipes. This README describes the convention so contributors and external consumers know which files are contracts, which are recipes, and how distribution works.

## Per-app layout

```
apps/<app>/
├── blocks/                  jsrepo items + the npm package surface
│   ├── workspace.ts         schema: tables, branded IDs, KV, actions factory
│   ├── script.ts            recipe: open a Bun script peer
│   ├── daemon-route.ts      recipe: define a daemon route
│   └── snapshot.ts          recipe (Fuji only): read-only snapshot
├── src/                     the SvelteKit SPA (browser-only code)
└── package.json             "exports": { ".": "./blocks/workspace.ts" }
```

Tab Manager is the exception: it has no `blocks/` directory because it ships no script or daemon recipe today. Its schema lives at `src/lib/workspace/index.ts` and the `.` export points there.

## Two distribution channels, one source of truth

Every file in `blocks/` is reachable through both channels:

| Channel | Resolution | Used by |
| --- | --- | --- |
| npm `@epicenter/<app>` | `package.json` `.` export points at `blocks/workspace.ts` | the app's own SPA, internal monorepo consumers |
| jsrepo `epicenter/<app>/<name>` | `jsrepo.config.ts` lists each file as a registry item | external consumers running `bunx jsrepo add ...` |

`script.ts`, `daemon-route.ts`, and `snapshot.ts` import the schema via the **relative** path `./workspace.js` so a third-party consumer who copies the blocks into their tree gets a self-contained directory that works without installing `@epicenter/<app>` from npm. The SPA, sitting inside the same package, uses the npm alias and lands on the same file.

## Contract files vs recipe files

Both live in `blocks/`, but they have different fork semantics:

### `workspace.ts` is a **contract**

It defines the table shapes, branded IDs, and KV schema that every peer must agree on for Yjs sync to merge correctly.

Forking the table shape (renaming a column, changing its type, swapping the migration chain) **breaks sync compatibility** with peers running the canonical schema. Sync errors show up at the wire level, not the source level: writes from a forked peer don't appear in canonical peers' tables, and vice versa.

If you want to fork the schema, you're forking the whole network: your own daemon, your own peers, your own clients. That's the local-first promise — explicit and observable, not source-locked.

### `script.ts`, `daemon-route.ts`, `snapshot.ts` are **recipes**

Each one wires the schema into a runtime: a Bun script, a daemon route, a read-only snapshot. They're consumer-editable by design: swap the auth source, the sync URL, the route name, add materializers, drop kv attachment, whatever fits the consumer's environment.

`bunx jsrepo update epicenter/<app>/script` shows a focused diff against the canonical recipe; merging is a normal git operation, and forking is fine.

## Why this split

- **Auditability and transparency**: every file a third-party runtime executes can be read in this repo, copied wholesale, and modified locally. No "magic" black-box helpers.
- **No upgrade lock-in**: a consumer who pulls a block today and never updates still has a working tree on the version they pulled.
- **Single source of truth in the monorepo**: the SPA, the recipes, and the jsrepo manifest all reference the same physical files. No build step duplicates schema content.

## Adding a new app

1. Create `apps/<app>/blocks/workspace.ts` with the schema and actions factory.
2. Add `apps/<app>/package.json` with `"exports": { ".": "./blocks/workspace.ts" }`.
3. Add runtime recipe files (`script.ts`, `daemon-route.ts`) under `blocks/` as needed, importing the schema via the relative `./workspace.js` path.
4. Update the root `jsrepo.config.ts` to register the new blocks list.
5. Run `bun run jsrepo:build` and confirm the manifest contains the expected items.
