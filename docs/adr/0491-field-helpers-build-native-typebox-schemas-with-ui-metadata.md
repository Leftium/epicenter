# 0491. Field helpers build native TypeBox schemas with UI metadata

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

First-party App and Folder declarations need a narrow field vocabulary because
fields select generic editors. Their values still need TypeBox validation,
including nested payload schemas and native refinements. A closed schema
recognizer duplicated those checks and discarded hidden constraints when a
schema was copied as JSON.

## Decision

**`field.*` helpers return native TypeBox schemas annotated with `x-field`.**
`packages/definition/src/field/builders.ts` builds the constraints and editor
metadata from the same arguments. Top-level fields require helper provenance;
`field.json(inner)` accepts native TypeBox payload schemas. Metadata retains
literal kinds, select options, reference targets, and nullability in TypeScript.

**`compileData` owns one frozen snapshot of each declared field.**
It clones own string-keyed data properties with TypeBox's `Memory.Clone`,
freezes the copied plain objects and arrays, and compiles that snapshot. Native
composition happens before compilation. Functions, custom guards, and callback
closure state remain the author's responsibility. Table and field names come
from declaration keys.

**JSON safety precedes payload validation through a native conditional schema.**
The guard rejects non-JSON values and cycles without imposing storage size
limits. Folder KV and frontmatter retain their separate depth and width budget.
Conformance checks each field independently and retains valid fields when
others fail.

## Consequences

The closed recognizer and separate field validator disappear. TypeBox owns
validation semantics, and `x-field` owns editor selection. Hidden provenance
rejects lossy spreads before they silently drop constraints; it is a trusted
authoring check, not an integrity boundary for deliberate native edits.

Declarations can contain functions and hidden keywords. JSON serialization is
therefore not a complete representation of these first-party declarations.
Serialized Lens consumers have their own contract.

TypeBox 1.1.23 reports a failed JSON payload branch as a generic `then` error.
Local references beneath that branch rely on installed TypeBox resolution,
covered by regression tests. A TypeBox upgrade must preserve those behaviors.

## Considered alternatives

- A `{ kind, schema }` field wrapper duplicates the native schema boundary.
- Freezing helper outputs interferes with native composition and assigns schema
  ownership before the definition is compiled.
- A refinement after a recursive payload validates too late to reject cycles.
  A guard-first intersection still evaluates every member when collecting
  errors. The conditional chooses one branch for checks and errors.
