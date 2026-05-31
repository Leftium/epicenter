# `@examples/fuji`

The canonical Epicenter project layout demonstrated against `@epicenter/fuji`.

## What this shows

One project, one Fuji mount, declared in `epicenter.config.ts`. Markdown
projections live at the project root and are committed to git. Runtime state
(Yjs persistence, SQLite materializer) lives under `.epicenter/` and is
gitignored.

This example is the reference implementation of the layout spec at
`specs/20260522T220000-workspace-project-layout.md`. If the spec changes,
this example changes with it.

## Layout

```
examples/fuji/
├── package.json           dependencies (this file)
├── tsconfig.json          extends the repo base
├── epicenter.config.ts    REQUIRED. Marker + mount list.
├── .gitignore             Epicenter-managed (.epicenter/)
├── entries/               markdown projection (committed)
│   ├── welcome.md
│   └── hello-fuji.md
└── .epicenter/            created on first daemon run; gitignored
    ├── yjs/
    │   └── epicenter-fuji.db
    └── sqlite.db
```

## Run it

```sh
bun install
bun x epicenter daemon up -C examples/fuji
```

On first run the daemon creates `.epicenter/` and writes `sqlite.db` plus the
Yjs persistence file used by `attachProjectInfrastructure`. The current mount
materializes the live Y.Doc out to SQLite and writes markdown as a projection:
root row frontmatter plus entry body text read from the app-owned body Y.Doc.
Importing markdown back into Fuji body Y.Docs is follow-up work.

## Inspect the SQL mirror

```sh
sqlite3 examples/fuji/.epicenter/sqlite.db
sqlite> .tables
sqlite> SELECT id, title FROM entries;
```

The SQLite mirror is regenerable from the Yjs persistence file. Markdown in
`entries/` is not yet the canonical import source for Fuji bodies, so deleting
`.epicenter/` drops the daemon's runtime state.

## Edit a note

Today, edit through mount actions or a connected Fuji runtime and watch the
markdown and SQLite projections update. The reverse direction, editing
`entries/*.md` and having the daemon ingest body text back into entry body
Y.Docs, is planned follow-up work.

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

Planned path: create `entries/my-new-entry.md` with the same frontmatter shape
as the existing examples, then let future markdown import ingest frontmatter into
the root row and body text into the entry body Y.Doc.

## What this example deliberately omits

- Auth and sync. The example is local-only; no `epicenter auth login` step.
- Browser or Tauri frontend. The example is daemon-hosted only.
- Default materializer paths. This example overrides them so SQLite lands at
  `.epicenter/sqlite.db` and markdown lands under `./entries/`.
- Multiple mounts. This example keeps the mount list small so the project
  layout stays easy to inspect.

## See also

- `specs/20260522T220000-workspace-project-layout.md` for the full spec.
- `examples/notes-cross-peer/` for a two-peer sync demo (predates this layout).
- `apps/fuji/` for the full Tauri/Svelte app that consumes the same workspace.
