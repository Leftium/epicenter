# @epicenter/cli

A thin shell around your `epicenter.config.ts`. Three responsibilities:

1. Manage authentication sessions with Epicenter servers (`auth`).
2. Render a tree of the queries and mutations your config exposes (`list`).
3. Invoke one of them by dot-path (`run`).

Anything bigger than that — bulk operations, exports, ad-hoc transforms — is a user-authored `.ts` script that imports the config and runs under `bun run`. The config self-loads at import time, so there is nothing for the CLI to bootstrap.

## Installation

Inside this monorepo:

```json
{
    "dependencies": {
        "@epicenter/cli": "workspace:*"
    }
}
```

The package exposes the `epicenter` binary via `src/bin.ts`.

## The three commands

```bash
# auth
epicenter auth login --server https://api.epicenter.so
epicenter auth status
epicenter auth logout

# introspect
epicenter list                                      # every export + full tree
epicenter list tabManager.savedTabs                 # subtree
epicenter list tabManager.savedTabs.create          # action detail with flag help

# invoke
epicenter run tabManager.savedTabs.list
epicenter run tabManager.savedTabs.create --title "Hi" --url "https://..."
epicenter run tabManager.savedTabs.create @payload.json
cat payload.json | epicenter run tabManager.savedTabs.create
```

`run` resolves the first path segment against the exports of `epicenter.config.ts`; everything after walks into the underlying bundle (the `DocumentHandle`'s prototype) until it hits a branded `defineQuery` / `defineMutation` node.

## What your `epicenter.config.ts` must export

An **opened handle** — not a factory. A factory has no id to call on its own; a handle already has refcount `+1`, sync connected, persistence open.

```ts
// epicenter.config.ts
import * as Y from 'yjs';
import {
    defineDocument,
    defineTable,
    attachTables,
    defineQuery,
    defineMutation,
} from '@epicenter/workspace';
import { type } from 'arktype';

const SavedTab = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));

const tabManagerFactory = defineDocument((id) => {
    const ydoc = new Y.Doc({ guid: id });
    const tables = attachTables(ydoc, { savedTabs: SavedTab });

    return {
        ydoc,
        tables,
        savedTabs: {
            list: defineQuery({ handler: () => tables.savedTabs.getAllValid() }),
            create: defineMutation({
                input: /* TypeBox schema */ undefined as any,
                handler: (input) => tables.savedTabs.upsert(input),
            }),
        },
        [Symbol.dispose]() { ydoc.destroy(); },
    };
});

// The opened handle is what the CLI and scripts consume.
export const tabManager = tabManagerFactory.open('epicenter.tab-manager');
```

## Scripting

Skip the CLI entirely for anything non-trivial:

```ts
// scripts/export-tabs.ts
import { tabManager } from '../epicenter.config';
import { writeFile } from 'node:fs/promises';

try {
    await tabManager.whenReady;
    const tabs = await tabManager.tables.savedTabs.list();
    await writeFile('./tabs.json', JSON.stringify(tabs, null, 2));
} finally {
    tabManager.dispose();
}
```

```bash
bun run scripts/export-tabs.ts
```

## Public API

```ts
import {
    createCLI,              // binary entry (used by bin.ts)
    loadConfig,             // { configDir, entries: [{ name, handle }], dispose() }
    createSessionStore,     // device-code session persistence
    createAuthApi,          // typed Better Auth client
    EPICENTER_PATHS,        // home, authSessions, persistence(id)
} from '@epicenter/cli';
```

## Design doc

See `specs/20260421T155436-cli-scripting-first-redesign.md` for the full rationale — why 11 commands collapsed to 3, the `DocumentBundle` / `DocumentHandle` contract, and the prototype-chain gotcha in `iterateActions`.
