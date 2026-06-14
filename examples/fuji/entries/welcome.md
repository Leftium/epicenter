---
id: 01HM0000000000000000000000
title: Welcome to Fuji
subtitle: A canonical Epicenter root layout
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
import back into Fuji body Y.Docs is planned follow-up work.

For now, drive edits through the daemon's actions (queries and mutations defined
by `@epicenter/fuji`) or a connected Fuji runtime, then watch the markdown and
SQLite projections update.

## Layout

This fixture is a committed markdown projection for a Fuji mount:

- `epicenter.config.ts` is the Epicenter root marker and default-exports the mount list.
- `entries/` (this directory) holds the markdown projection.
- `.epicenter/` is the runtime cache (gitignored).

## Try it

    bun install
    bun x epicenter daemon up

The daemon materializes `.epicenter/yjs/epicenter-fuji.db` and
`.epicenter/sqlite.db` on first run. Inspect the SQLite mirror with
`sqlite3 .epicenter/sqlite.db` for queryable access to the same data.
