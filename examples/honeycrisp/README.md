# `@examples/honeycrisp`

The canonical Epicenter folder layout demonstrated against `@epicenter/honeycrisp`.

## What this shows

One Epicenter folder, one Honeycrisp mount, declared in `epicenter.config.ts`.
The mount projects its markdown to `notes/` (a direct child of the Epicenter
root, one folder per exported table) and the daemon keeps machine state under
`.epicenter/`. The projection is tracked in git; only `.epicenter/` is
gitignored.

This example is the reference implementation of the Epicenter folder layout
described below.

## Layout

The Epicenter root is the folder that holds `epicenter.config.ts`. Here that is
`examples/honeycrisp/`; the folder name is arbitrary and nothing reserves the
name `apps`.

```
examples/honeycrisp/
├── package.json                     dependencies (this file)
├── tsconfig.json                    extends the repo base
├── epicenter.config.ts              REQUIRED. Marker + mount.
├── .gitignore                       tracks the config and notes/, ignores .epicenter/
├── notes/                           markdown projection for the notes table (tracked)
│   ├── 01HM0000000000000000000000.md    committed seed; the daemon rewrites it on each run
│   └── 01HM0000000000000000000001.md
└── .epicenter/                      machine state; created on first daemon run
    ├── yjs/
    │   └── <id>.db                  Yjs persistence, keyed by ydoc.guid
    └── sqlite/
        └── <id>.db                  SQL materializer, keyed by ydoc.guid
```

## Run it

```sh
bun install
bun x epicenter daemon up -C examples/honeycrisp
```

On first run the daemon creates `.epicenter/` and writes the guid-keyed SQLite
mirror plus the Yjs persistence file used by `attachMountInfrastructure`. The
mount materializes the live Y.Doc out to SQLite and writes markdown as a
projection under `notes/`, one file per row, named `<id>.md`. Honeycrisp's
mount uses the export's default `toMarkdown` (frontmatter is the row, no
body): the note's rich-text body lives in a separate child Y.Doc that the
daemon does not currently render to disk. That is different from Fuji, whose
mount fetched and serialized its entry body per row; Honeycrisp hasn't grown
that yet.

## Inspect the SQL mirror

The SQLite mirror is guid-keyed, so resolve the file from the workspace id
(`ydoc.guid`) under `.epicenter/sqlite/`:

```sh
sqlite3 examples/honeycrisp/.epicenter/sqlite/<id>.db
sqlite> .tables
sqlite> SELECT id, title FROM notes;
```

The SQLite mirror is regenerable from the Yjs persistence file, so deleting
`.epicenter/` drops the daemon's runtime state.

## Edit a note

Today, edit through the Honeycrisp app (browser) and watch the markdown and
SQLite projections update. There is no markdown import path: editing
`notes/*.md` directly is not read back.

Honeycrisp's own mutation, `folders_delete`, is reachable headlessly through
the daemon's RPC actions. Use the CLI:

```sh
bun x epicenter run folders_delete '{"folderId":"<id>"}' -C examples/honeycrisp
```

The action set is defined by `@epicenter/honeycrisp` and re-exposed through
this example's `epicenter.config.ts`. Honeycrisp does not (yet) expose
create/update actions for `notes` over the daemon; notes are authored through
the app, and the daemon mount only materializes what already exists.

## What this example deliberately omits

- Auth and sync. The example is local-only; no `epicenter auth login` step.
- Browser or Tauri frontend. The example is daemon-hosted only.

## See also

- `examples/notes-cross-peer/` for a two-peer sync demo (predates this layout).
- `apps/honeycrisp/` for the full Svelte app that consumes the same workspace.
