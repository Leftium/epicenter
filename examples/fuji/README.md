# `@examples/fuji`

The canonical Epicenter folder layout demonstrated against `@epicenter/fuji`.

## What this shows

One Epicenter folder, one Fuji mount, declared in `epicenter.config.ts`. The
mount projects its markdown to `fuji/` (a direct child of the Epicenter root,
keyed by the mount name) and the daemon keeps machine state under `.epicenter/`.
Both are gitignored; `epicenter.config.ts` is the tracked boundary marker.

This example is the reference implementation of the layout spec at
`specs/20260612T000201-epicenter-namespace-root-layout.md`. If the spec changes,
this example changes with it.

## Layout

The Epicenter root is the folder that holds `epicenter.config.ts`. Here that is
`examples/fuji/`; the folder name is arbitrary and nothing reserves the name
`apps`.

```
examples/fuji/
├── package.json           dependencies (this file)
├── tsconfig.json          extends the repo base
├── epicenter.config.ts    REQUIRED. Marker + mount list.
├── .gitignore             tracks the config, ignores .epicenter/ and fuji/
├── entries/               sample seed markdown (committed)
│   ├── welcome.md
│   └── hello-fuji.md
├── fuji/                  markdown projection for the `fuji` mount (generated)
└── .epicenter/            machine state; created on first daemon run
    ├── yjs/
    │   └── <id>.db        Yjs persistence, keyed by ydoc.guid
    └── sqlite/
        └── <id>.db        SQL materializer, keyed by ydoc.guid
```

## Run it

```sh
bun install
bun x epicenter daemon up -C examples/fuji
```

On first run the daemon creates `.epicenter/` and writes the guid-keyed SQLite
mirror plus the Yjs persistence file used by `attachMountInfrastructure`. The
mount materializes the live Y.Doc out to SQLite and writes markdown as a
projection under `fuji/`: root row frontmatter plus entry body text read from
the app-owned body Y.Doc. Importing markdown back into Fuji body Y.Docs is
follow-up work.

## Inspect the SQL mirror

The SQLite mirror is guid-keyed, so resolve the file from the workspace id
(`ydoc.guid`) under `.epicenter/sqlite/`:

```sh
sqlite3 examples/fuji/.epicenter/sqlite/<id>.db
sqlite> .tables
sqlite> SELECT id, title FROM entries;
```

The SQLite mirror is regenerable from the Yjs persistence file, so deleting
`.epicenter/` drops the daemon's runtime state.

## Edit a note

Today, edit through mount actions or a connected Fuji runtime and watch the
markdown and SQLite projections update. The reverse direction, editing
`fuji/*.md` and having the daemon ingest body text back into entry body Y.Docs,
is planned follow-up work.

You can also drive changes through the daemon's RPC actions. Use the CLI:

```sh
bun x epicenter run fuji.entries_get '{"id":"01HM0000000000000000000000"}' -C examples/fuji
```

The action set is defined by `@epicenter/fuji` and re-exposed through this
example's `epicenter.config.ts`.

## Add a new entry

Current path:

1. **Call a mutation.** Use the CLI's `run` subcommand to invoke the
   mount's create action.

Planned path: create a markdown file with the same frontmatter shape as the
seed `entries/*.md`, then let future markdown import ingest frontmatter into
the root row and body text into the entry body Y.Doc.

## What this example deliberately omits

- Auth and sync. The example is local-only; no `epicenter auth login` step.
- Browser or Tauri frontend. The example is daemon-hosted only.
- Multiple mounts. This example keeps the mount list small so the layout stays
  easy to inspect.

## See also

- `specs/20260612T000201-epicenter-namespace-root-layout.md` for the full spec.
- `examples/notes-cross-peer/` for a two-peer sync demo (predates this layout).
- `apps/fuji/` for the full Tauri/Svelte app that consumes the same workspace.
