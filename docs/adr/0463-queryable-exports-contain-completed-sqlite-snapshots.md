# 0463. Queryable exports contain completed SQLite snapshots

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient folder query sessions separately from app/account working state.
- **Unbuilt:** SQL snapshot generation, standalone export validation, and complete public folder publication. No live root database filename is reserved by the folder engine.

## Context

Markdown rows and ordinary media files are readable and editable, but ordinary
SQL tools need a database to query them. A completed database can describe one
selected file snapshot without making SQLite the saved authority.

The earlier root `index.sqlite3` proposal reserved a filename in every live
folder. There is no generator or external reader relying on that path.
A transient query session and a completed export differ in lifetime and
publication. Neither requires a saved database inside the live folder.

## Decision

**An explicit query export produces a completed SQLite snapshot at a chosen destination, defaulting to `query.sqlite3`.**
No live folder root reserves a database filename. The export can be a standalone
database or a selected folder containing authored files, selected media, and
the completed database. SQL projects the interpreted rows and settings from
that selection. No database is required to open or recover authored files.

```text
live source folder/                  chosen complete export/
  kv.json                              kv.json
  recordings/r123.md                    recordings/r123.md
  recordings/r123.opus                  recordings/r123.opus
                                       query.sqlite3
```

The export remains unchanged until explicitly regenerated. It is a read
snapshot, not evidence that current source still matches it. Direct SQL writes
do not edit Markdown or establish another saved authority. The destination may
use another filename; no index-versus-query format distinction is introduced.
Projection code can be shared with transient query sessions. Detailed schema
and column names remain a separate decision. Exported tables need an explicit
public contract rather than exposing the session engine by accident. An export
written inside a live folder is an ordinary authored file; its name supplies no
special source exclusion or cache lifecycle.

**A completed export opens without required WAL or journal companions.**
Generation selects one immutable captured file set, stages and validates the
database, and publishes it only after completion. Failure preserves source
and an existing completed export. Copying arbitrary live database bytes does
not satisfy this contract. Neither a continuous watcher nor background root
snapshot refresh is required. Packaging and the publication switch mechanism
remain implementation decisions.

Files, media, and SQL in one export derive from that same captured set. Capture
orders admitted owner operations but does not freeze arbitrary external editors;
it does not promise an atomic observation of the entire live directory. Report
unreadable or disappearing files and state the capture boundary rather than
substituting a committed tree or silently claiming completeness.

**Selected media retains its authored relative paths.**
A generated projection may expose captured media paths as text. Matching row
and media stems do not infer ownership or select files for export. Selection
uses explicit paths or references under a stated application policy. Unresolved
required references are reported. For a complete folder export, locators are
relative to the export root containing the default `query.sqlite3`; another
database location must preserve or explicitly regenerate those locators. SQL
does not embed or retrieve the media bytes. A standalone database export does
not promise complete media; its media-location contract must be stated.

**Public exports are generated from selected, redacted public files.**
Selection and removal of private fields and body material happen before SQL
generation. Query filters cannot protect private values in a downloadable
database. A complete public publication contains that selected file set, its
selected media, and a database generated from the same snapshot. Referenced
dependencies are included or reported unresolved; a complete-media promise
requires their bytes.

Application SQL and credentials are not published as source. No new
`.epicenter/` directory is created or excluded by this export contract. Managed
SQLite ignore defaults remain unbuilt under ADR-0494; intentional saved
databases follow ordinary history rules and can use an explicit ignore exception.
That choice does not turn it into an app-maintained live cache.

## Consequences

- Completed exports have a default filename and may share projection code
  with transient sessions. Live folders require no persistent query database.
- Export is an explicit operation. External tools use its selected destination
  rather than assuming every folder has a continuously current SQL file.
- A standalone database contains queryable values and locators, not attachment
  bytes. A complete folder export includes the selected required media.
- An export can duplicate sensitive text. Public generation must follow
  selection and redaction; SQL filters cannot substitute for them.
- Hosting a SQLite download does not supply a browser SQL interface. A query
  service or client-side reader remains a separate consumer.

## Considered alternatives

- Reserve root `index.sqlite3`: requires a second name and path exclusions
  without a caller needing automatic root discovery.
- Export arbitrary live cache bytes: does not establish a completed standalone
  database, selected public data, or consistent attachment locators.
- Keep an export continuously current: adds watching and publication work
  before an external reader requests a snapshot.
- Move attachments to generic `blobs/` or embed them all in SQLite: changes
  visible ownership and ordinary file access without helping SQL query results.
