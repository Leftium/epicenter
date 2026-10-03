# 0467. File workflows report each operation's outcome

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** removal of generic partial-result APIs and application migration to individual operation outcomes.

## Context

The file foundation exposed ordered native operations and `Partial` progress.
Browser transactions gave stronger multi-file publication. Individual public
operations remove that portable batch contract while preserving interruption
and lost replies as facts applications must handle.

## Decision

**Report file publication independently of Git history.**
A confirmed file save remains saved after a commit or push failure. Later history
records current files; it does not complete a missing workflow step or certify
which command published them.

**Related-file workflows retain their own progress.**
Each operation reports confirmation, refusal, failure or uncertainty about its
own publication. If a recording's audio succeeds and its row fails, the app
retains that recording's input and reports its unfinished row. The folder exposes
no generic `Partial` result, cross-file transaction or journal for ordinary saves.

A move still involves two paths. A native fallback that creates a destination
before removing its source can leave both files after interruption. Its error
must retain that specific evidence; removing the generic batch result does not
make movement atomic. Applications inspect both paths before an explicit repair.

**An unknown reply does not become confirmed through a matching read.**
A read establishes current content. It cannot establish which command wrote it
or that an outstanding command cannot arrive later. Preserve the attempt as
history, retain unsaved input, and inspect current paths before a renewed action.
Do not blindly repeat destructive work against a recreated row or changed file.

**Incoming Git adoption owns its separate durable recovery record.**
ADR-0474 pins the before and after commits and permits conditional roll-forward.
That Git-specific record prevents checkpoints of a mixed incoming tree until
recovery completes. It imposes no generic journal on ordinary app edits.

## Consequences

Applications report their workflow progress without importing a generic
multi-step receipt schema. Concurrent outside writers can still change files,
and uncommitted overwritten bytes may be unrecoverable. Editor buffers are not
durable recovery or backup.

## Considered alternatives

- Journal every file operation: adds durable intent and fencing to ordinary saves.
- Treat a commit as recovery: Git can record a workflow's intermediate files
  without completing it.
- Retry the old operation against current paths: can erase a later writer's work.
