# 0487. KV commands distinguish creation from current-source updates

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

Folder settings live in one `kv.json` file. Whispering reads the settings as a
map, creates defaults on first launch, and assigns several settings together.
Its settings commands reread the current document before saving. Complete-text
repair already uses the ordinary file editor.

Encoding absence as a snapshot with no source or hash made one write method
choose between creation and replacement. Parsing and serializing the whole
object also changed unknown numeric values during unrelated settings edits.

## Decision

KV exposes three methods:

```ts
folder.kv.get()
folder.kv.create(values)
folder.kv.update(values)
```

`get` returns `undefined` only for absence. Every snapshot describes a real
file and carries its exact source and SHA-256. Readable malformed JSON remains
a snapshot with issues; unreadable bytes remain an error. Declared values are
validated independently, and missing declared settings are permitted.

`create` validates the supplied partial map and publishes exclusively without
reading. `update` owns its supplied values before awaiting, reads current
source once, patches only supplied root keys, and replaces against that read's
hash. Absence is `NotFound`; a publication race is `Conflict`. Neither method
retries. Successful writes return the submitted source and its hash without a
read-back observation.

JSON syntax-tree offsets identify editable spans. Untouched source remains
exact, including unknown nested numeric tokens. Structured updates refuse
malformed or non-object JSON and repeated occurrences of a supplied key.
Unknown duplicate keys remain untouched. Full-text repair uses
`files.replace(snapshot, source)`.

Files, tables, and KV are sibling factories over accounted, fenced storage:

```ts
createFiles({ storage })
createTable({ storage }, definition)
createKv({ storage }, definition)
```

Applications own defaults, retries, and recreation policy. Whispering keeps its
one-conflict retry and explicitly creates only the supplied patch after a
missing-file refusal. Startup seeds defaults only after its own successful
absent observation, and awaits that creation before installing its close guard.

## Consequences

Absence no longer has a file capture. Structured settings commands accept
values without a preliminary caller read. KV has no separate raw replacement
method, cache, operation registry, or history callback.

Source-preserving edits require a JSON syntax parser. Duplicate supplied keys
require manual source repair before a structured update. Typed supplied values
must be representable as JSON; raw file editing retains arbitrary source.
`update` assigns current values and does not protect an earlier displayed
snapshot. The ordinary file editor retains captured-baseline protection.

## Considered alternatives

A merging `set` hides what happens to omitted fields. Per-key writes split a
multi-setting command into several publications. An upserting `update` cannot
seed defaults safely after an earlier absence observation: another writer may
have created settings in between. A captured structured update preserves an
argument that production callers immediately reread. A KV source-replacement
method duplicates the existing ordinary file repair path.
