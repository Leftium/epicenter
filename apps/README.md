# Apps

Each app under `apps/` is a workspace package that ships one schema and a small set of runtime recipes. This README describes the convention so contributors and external consumers know which files are contracts, which are recipes, and how distribution works.

## Per-app layout

```
apps/<app>/
├── blocks/                  jsrepo items + the npm package surface
│   ├── workspace.ts         schema: tables, branded IDs, KV, actions factory
│   └── daemon-route.ts      recipe: long-lived writer (auth, sync, materializers, actions)
├── src/                     the SvelteKit SPA (browser-only code)
└── package.json             "exports": { ".": "./blocks/workspace.ts" }
```

Every app ships `workspace.ts` and `daemon-route.ts`. Tab Manager is the exception: it has no `blocks/` directory because it has no daemon today. Its schema lives at `src/lib/workspace/index.ts` and the `.` export points there.

### The single-writer principle

One process per workspace per machine owns writes and network. Everything else is a reader.

- **`daemon-route.ts` is the writer.** It holds the auth client, the live Y.Doc, the WebSocket to the relay, the yjsLog writer, and the materializers (SQLite, Markdown, etc.). It hosts actions over IPC so other local processes can request mutations.
- **Browsers are co-equal writers over Yjs.** A peer that calls `openCollaboration({ actions })` registers the same action runner, so the browser SPA and the daemon both accept calls against the same workspace.
- **Scripts are short-lived readers + IPC clients.** They never hold a Y.Doc. They read the daemon's SQLite materializer and call typed actions through `connectDaemonActions`. There is no `script.ts` recipe; a script is a user-owned Bun file. See `docs/scripting.md`.

Why this matters: Yjs is conflict-free for the document, but materializers are not. Two SQLite writers or two Markdown emitters on the same file tree converge to a corrupted disk state even while the CRDT happily merges. Single-writer collapses that risk. It also keeps per-machine network usage to one WebSocket per workspace, and keeps scripts cheap enough to run from `bun run`, cron, or pre-commit without standing up auth and sync each time.

### Scripts are user files, not recipes

A script is a Bun file that reads the materializer directly and writes through the daemon. Three imports cover the whole shape:

```ts
import { connectDaemonActions } from '@epicenter/workspace';
import { findEpicenterDir, openWorkspaceSqlite } from '@epicenter/workspace/node';
import { FUJI_WORKSPACE_ID, type FujiActions } from '@epicenter/fuji';

const projectDir = findEpicenterDir();

const db = openWorkspaceSqlite(projectDir, FUJI_WORKSPACE_ID);
const urgent = db.query('SELECT * FROM entries WHERE tag = ?').all('urgent');

const fuji = await connectDaemonActions<FujiActions>({ route: 'fuji', projectDir });
for (const note of urgent) {
  await fuji.entries_update({ id: note.id, tags: ['triaged'] });
}

db.close();
```

No machine auth, no encryption setup, no Y.Doc replay, no jsrepo block. The full reasoning lives in `docs/scripting.md`.

## Two distribution channels, one source of truth

Every file in `blocks/` is reachable through both channels:

| Channel | Resolution | Used by |
| --- | --- | --- |
| npm `@epicenter/<app>` | `package.json` `.` export points at `blocks/workspace.ts` | the app's own SPA, internal monorepo consumers |
| jsrepo `epicenter/<app>/<name>` | `jsrepo.config.ts` lists each file as a registry item | external consumers running `bunx jsrepo add ...` |

`daemon-route.ts` imports the schema via the **relative** path `./workspace.js` so a third-party consumer who copies the block into their tree gets a self-contained directory that works without installing `@epicenter/<app>` from npm. The SPA, sitting inside the same package, uses the npm alias and lands on the same file.

## Contract files vs recipe files

Both live in `blocks/`, but they have different fork semantics:

### `workspace.ts` is a **contract**

It defines the table shapes, branded IDs, and KV schema that every peer must agree on for Yjs sync to merge correctly.

Forking the table shape (renaming a column, changing its type, swapping the migration chain) **breaks sync compatibility** with peers running the canonical schema. Sync errors show up at the wire level, not the source level: writes from a forked peer don't appear in canonical peers' tables, and vice versa.

If you want to fork the schema, you're forking the whole network: your own daemon, your own peers, your own clients. That's the local-first promise: explicit and observable, not source-locked.

### `daemon-route.ts` is a **recipe**

It wires the schema into the long-lived writer: auth, sync, materializers, and actions. It is consumer-editable by design: swap the auth source, the sync URL, the route name, add materializers, drop kv attachment, whatever fits the consumer's environment.

`bunx jsrepo update epicenter/<app>/daemon-route` shows a focused diff against the canonical recipe; merging is a normal git operation, and forking is fine.

## Why this split

- **Auditability and transparency**: every file a third-party runtime executes can be read in this repo, copied wholesale, and modified locally. No "magic" black-box helpers.
- **No upgrade lock-in**: a consumer who pulls a block today and never updates still has a working tree on the version they pulled.
- **Single source of truth in the monorepo**: the SPA, the recipes, and the jsrepo manifest all reference the same physical files. No build step duplicates schema content.

## Adding a new app

1. Create `apps/<app>/blocks/workspace.ts` with the schema and actions factory.
2. Add `apps/<app>/package.json` with `"exports": { ".": "./blocks/workspace.ts" }`.
3. Add `apps/<app>/blocks/daemon-route.ts` (the writer). Import the schema via the relative `./workspace.js` path.
4. Update the root `jsrepo.config.ts` to register the new blocks list.
5. Run `bun run jsrepo:build` and confirm the manifest contains the expected items.
