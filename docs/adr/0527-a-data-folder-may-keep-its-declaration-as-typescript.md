# 0527. A data folder may keep its declaration as TypeScript

- **Status:** Proposed
- **Date:** 2026-10-11
- **Amends:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) at "nothing executes the folder's code": `epicenter generate` runs the folder's `epicenter.ts`; `check` and `query` still never do. [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) at its rejected `epicenter.config.ts`: the TypeScript file is a source a person runs on purpose, never what a reader reads.
- **Relates:** [ADR-0525](0525-a-field-is-plain-json-schema.md) (a field is plain JSON Schema), [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) (`field.optional` and `required`)

## Context

A data folder no app owns, such as a hand-written vault, keeps its
declaration in `epicenter.json`. Writing that JSON by hand means spelling
each table as an object schema and keeping `required` in step with the
fields. The field helpers say the same thing in a few lines, with types,
`field.optional`, and editor hints. ADR-0520 removed the CLI's
`epicenter.config.ts` execution because running a cloned repository's code to
read its data is unsafe.

## Decision

**A data folder may keep `epicenter.ts`, whose default export is
`defineFolder({ ... })`, and `epicenter generate <dir>` writes the
`epicenter.json` it declares.**

```ts
// epicenter.ts
import { defineFolder, defineTable, field } from '@epicenter/folder';

export default defineFolder({
  kv: {},
  tables: {
    pages: defineTable({
      fields: { title: field.string(), queuedAt: field.optional(field.date()) },
    }),
  },
});
```

```text
epicenter generate <dir>          write epicenter.json from epicenter.ts
epicenter generate <dir> --check  write nothing; exit 1 when they differ
```

- `epicenter.json` stays the only declaration a reader reads. `check`,
  `query`, `readFolder`, and every app read the JSON and never run
  `epicenter.ts`, so reading a cloned repository still runs none of its code.
- `generate` is the one command that runs a folder's code, and only when a
  person or agent asks for it on that folder.
- The file is `epicenter.ts`, not `epicenter.config.ts`: it declares data,
  and "config" names tool settings.
- `epicenter.ts` may import `@epicenter/folder`, `@epicenter/folder/bun`,
  `@epicenter/definition`, `@epicenter/definition/field`, `typebox`, and
  `typebox/compile`, `/format`, and `/value`. `generate` resolves them to the
  checkout's own packages, so a folder in any repository needs no install,
  and a copy the folder installed never wins.
- A default export that is not an object, or that has a key other than
  `title`, `kv`, and `tables`, is refused rather than dropped.
- `--check` lets a repository's CI or an agent confirm the JSON matches the
  source.

## Consequences

- When an app opens the folder it replaces `epicenter.json` (ADR-0517), and
  `epicenter.ts` then describes something else. The TypeScript source is for
  folders no app owns.
- An editor outside this monorepo cannot type-check `epicenter.ts` until the
  folder package is installable; `generate` still runs it.
- Until the CLI is distributed, `generate` runs from an Epicenter checkout, as
  `check` and `query` do.

## Considered alternatives

- **Readers run `epicenter.ts` when no JSON exists.** Brings back running a
  cloned repository's code to read its data.
- **Only hand-written JSON.** Correct but verbose, and `required` drifts from
  the fields a person meant.
- **A separate `@epicenter/cli init` scaffold.** Writes the file once and
  leaves later edits to hand-written JSON.

## Verification

`scripts/epicenter.test.ts` covers writing the JSON from `epicenter.ts`,
`--check` for a stale and a current file, refusal of a missing source, a
missing default export, and a declaration preparation refuses, and that
`check` and `query` never run `epicenter.ts`.
