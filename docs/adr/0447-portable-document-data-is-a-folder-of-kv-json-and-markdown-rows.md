# 0447. Portable document data is a folder of kv.json and Markdown rows

- **Status:** Proposed
- **Date:** 2026-09-28
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the file layout; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at the existing Yjs checkout
- **Unbuilt:** opening document libraries from canonical files in browser and desktop apps, source-preserving edits, consistent snapshots, and migration from existing stores.

## Context

`renderArtifact` already produces `kv.json` and `<table>/<row-id>.md`. The files are an artifact of a Yjs store. ADR-0337 makes the folder a working copy: a person pulls data into it and pushes edits back to the store. That cycle gives the same document two owners and requires a manifest to reconcile them.

For notes, tasks, transcripts, and similar document data, the useful portable form is already the readable file. An application can interpret its fields and body without owning their durable representation. A browser can keep the same logical paths in private storage even when it cannot expose an ordinary operating-system folder.

## Decision

**For document-shaped data a person owns, the folder is the authoritative working data.** Its structured layout is:

```txt
<library>/
  kv.json                 stored library values
  <table>/<row-id>.md     one row: YAML frontmatter and Markdown body
```

`kv.json` is one JSON object. A row's path supplies its table and stable row identity. Its frontmatter holds fields; its body holds document content when the row has a body. An app may interpret those files through a definition, but an unreadable field or unsupported body syntax does not remove the source file. Editing a file changes the data without a separate push into a Yjs row.

Git may add revisions and synchronization around this folder. Neither `.git` nor a `library.json` or `epicenter.json` marker is required to read its current structured data. A portable identity or format marker needs a separate decision if an operation demonstrates why paths and contents are insufficient.

This rule applies to portable document libraries. It does not turn borrowed mirrors, credentials, device settings, or every application database into Markdown files. Existing Yjs stores keep their checkout behavior until their data is deliberately migrated.

## Consequences

Apps, external editors, and agents can work on the same source format. SQLite and search indexes derive from the files and can be rebuilt. For migrated document libraries, the Yjs-to-folder pull, push, and baseline manifest cease to be the normal editing boundary.

The library must make acknowledged file writes durable, preserve source an app does not understand, and detect stale edits rather than silently overwrite them. A current-state snapshot can copy the authoritative files without Git, but it must capture one consistent cut. A recording's snapshot must also include its audio. Binary layout and transfer, historical snapshots, synchronization, and account binding still need their own contracts. A copied folder is a complete current snapshot only when all referenced bytes are present.

## Considered alternatives

- Keep Yjs authoritative and treat Markdown as an export. This retains the pull and push boundary for the data whose normal form is already the file.
- Require Git for every library. This makes local use and a current-state snapshot depend on a history mechanism they do not need.
