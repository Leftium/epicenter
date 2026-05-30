---
id: 01HM0000000000000000000000
title: Welcome to Fuji
subtitle: A canonical Epicenter project layout
type: []
tags: ["welcome"]
pinned: true
date: 2026-05-22T00:00:00Z
createdAt: 2026-05-22T00:00:00Z
updatedAt: 2026-05-22T00:00:00Z
rating: 0
_v: 2
---

# Welcome to Fuji

This file is the committed markdown projection for one Fuji entry. Today the
daemon writes files like this from the in-memory Yjs document. Markdown
hydration will make these files the source that can rebuild the runtime cache.

For now, drive edits through the daemon's actions (queries and mutations defined
by `@epicenter/fuji`) or a connected Fuji runtime, then watch the markdown and
SQLite projections update.

## Layout

The project's data layout is documented in `specs/20260522T220000-workspace-project-layout.md`:

- `epicenter.config.ts` is the project marker and default-exports the mount list.
- `entries/` (this directory) holds the markdown source of truth.
- `.epicenter/` is the runtime cache (gitignored).

## Try it

    bun install
    bun x epicenter daemon up

The daemon materializes `.epicenter/yjs/epicenter.fuji.db` and
`.epicenter/sqlite.db` on first run. Inspect the SQLite mirror with
`sqlite3 .epicenter/sqlite.db` for queryable access to the same data.
