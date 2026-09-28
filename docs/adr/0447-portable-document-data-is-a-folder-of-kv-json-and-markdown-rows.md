# 0447. Portable document data is a folder of kv.json and Markdown rows

- **Status:** Proposed
- **Date:** 2026-09-28
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the file layout; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at the existing Yjs checkout
- **Unbuilt:** opening canonical libraries in desktop and browser apps, complete row-owned attachments, Git synchronization, consistent snapshots, and migration from existing stores.

## Context

`renderArtifact` produces `kv.json` and `<table>/<row-id>.md`, but the files are an artifact of a Yjs store. Recording rows still contain `audioBlobId`; their audio lives in a separate blob store and may be uploaded through another channel. Copying the artifact does not copy a complete recording.

ADR-0337 makes the folder a working copy: a person pulls data into it and pushes edits back to the store. That cycle gives a document two owners and requires a manifest to reconcile them. A separate Local and Personal store would also require attachment transfer and deletion coordination.

## Decision

**For portable document libraries, the folder contains the authoritative current data, including files owned by rows.** Its layout is:

```txt
<library>/
  kv.json                          library values, excluding device settings
  <table>/<row-id>.md              one row: YAML frontmatter and Markdown body
  <table>/<row-id>/<filename>      optional file owned by that row
```

`kv.json` is one JSON object. A row's Markdown path supplies its table and stable row identity. Its frontmatter holds fields; its body holds document content when the row has a body. The optional directory has the same table and row identity and contains one primary file, including a file whose extension is `.md`. A recording's audio lives there. A reusable file belongs to its own row in a `files` table; other rows may refer to it without owning its lifetime. No independently synchronized blob ID, blob inventory, or per-recording upload marker is part of this format.

**A row file is the publication point for its owned file.** An app finishes writing the owned bytes before publishing the Markdown row. It removes the Markdown row before removing owned bytes. An interrupted operation may leave orphan bytes, which readers preserve and do not present as a completed row. A row whose expected bytes are absent remains visible with a missing-file error; the app does not silently discard or repair its source. Apps do not replace a recording's original audio in place.

**Git is the expected history and synchronization engine for a library.** A completed sync transfers rows and their owned files together. Removing a row and its owned file removes them from the current revision; Git history may retain both, and restoring an earlier revision may restore the same row identity. There is no permanent row retirement or audio purge promise. An app opens the current files without requiring `.git`, so a copied current-state folder remains readable. Neither `library.json` nor `epicenter.json` is required to identify the file layout.

An app may interpret files through a definition, but an unreadable field, unsupported body, or conflicted file does not remove the source. Editing a file changes the data without pushing it into a Yjs row. An app detects changes made since it read a file before replacing that file. Sync and app writes must be coordinated so a Git worktree change cannot silently overwrite a pending edit.

This rule applies to portable document libraries. It does not turn borrowed mirrors, credentials, device settings, or every application database into Markdown files. Existing Yjs stores keep their checkout behavior until deliberately migrated.

## Consequences

Apps, editors, and agents can work on the same current files. SQLite and search indexes derive from them and can be rebuilt. For migrated libraries, the Yjs-to-folder pull, push, and baseline manifest cease to be the normal editing boundary. The separate attachment remote, upload timestamp, availability marker repair, and deletion retirement protocol are unnecessary for these libraries.

A current-state snapshot must include `kv.json`, Markdown rows, and every owned file at one consistent cut. A history archive must include the selected Git refs and all binary objects those refs require. Git LFS can store large files without changing this layout, but a pointer-only clone or Git-only archive is incomplete. The choice between ordinary Git and Git LFS for recordings depends on recording size and a clone, playback, and restore proof.

Git does not make several filesystem writes atomic or prevent a person from committing a Markdown row without its audio. An app must validate file completeness before reporting a completed save or sync. Browser and phone adapters must preserve the same logical paths and completeness rule; their folder access and Git transport require separate proof.

## Considered alternatives

- Keep Yjs authoritative and treat Markdown as an export. This retains the pull and push boundary for data whose normal form is the file.
- Keep a separate Local and Personal attachment transfer protocol. This gives records and bytes different owners and restores the upload and deletion coordination that a whole-library Git sync removes.
- Require `.git` to read a library. This makes opening a current-state copy depend on history metadata even though its data files are present.
