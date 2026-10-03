# 0482. Folder mutations publish one file at a time

- **Status:** Proposed
- **Date:** 2026-10-01
- **Unbuilt:** removal of public batches and generic partial results, independent recording publication, and migrated application recovery.

## Context

`folder.batch` collects file writes and table-row creation under one admission.
The browser applies them transactionally; native publication can stop between
steps. The collector, ordered receipts and generic `Partial` result make every
consumer account for a multi-file operation model.

Whispering needs to save audio and its recording row. That relationship belongs
to a recording workflow, while each table still owns only one Markdown file.

## Decision

**The public folder API exposes individual operations, without a batch collector or generic `Partial` result.**
File operations publish their named file. Table creation, editing and deletion
act on the row file. KV saves act on `kv.json`. Each confirmed result proves
that operation's publication independently of later reads and Git history.

**The application owns related-file workflow progress and recovery.**
Whispering fixes its recording ID before publication, creates audio, then creates
the row through the table's serializer. It retains the pending bytes if the row
fails after audio succeeds. Explicit retry reads those same paths, validates
matching audio and recording identity, and finishes an absent step. It refuses
foreign occupants and does not rewrite matching audio merely to manufacture a
cross-file condition. Another writer can change audio between operations; the
workflow reports what it observes without claiming a transaction.

A row references audio through `audioPath`; it does not own that file's lifetime.
Deleting or moving a row does not delete or move its audio. A file whose stem
merely matches the recording ID is not evidence of ownership.

**Publication evidence and current observation remain separate.**
Confirmed audio and row results establish what their operations published.
A later unreadable, missing or foreign row does not erase that evidence or
permit recreation. An unknown reply remains unknown even if a read finds the
desired bytes. Recovery can establish that the intended content is present
without assigning that content to a particular command.

Individual saves request history under the opened folder's policy. A checkpoint
can contain audio before its row. Commit or push failure does not make a
confirmed file save fail. Git incoming adoption has its own durable recovery
contract under ADR-0474; it is not a public general-purpose batch.

## Consequences

The collector, synchronous callback restrictions, batch receipt schema and
portable multi-step error protocol can disappear. Recording recovery remains
app-owned state because a two-file workflow can stop after one publication.
Each app must report its own progress without presenting intermediate files as
an atomic completed action.

## Considered alternatives

- Keep `folder.batch`: couples every backend and consumer to generic ordered
  composition for one recording workflow.
- Attach audio to `table.create`: makes the table own files outside its row.
- Hold commits until every app workflow finishes: requires generic workflow
  registration and durability beyond the file save contract.

Related decisions: [file verbs](0479-file-mutation-methods-express-publication-intent.md),
[row-only tables](0480-file-tables-own-only-their-markdown-row-files.md), and
[independent history](0468-file-saves-succeed-independently-of-automatic-commits.md).
