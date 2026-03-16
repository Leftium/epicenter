# Refactor `create-document.ts` and Document Subsystem

**Date**: 2026-03-16
**Status**: Draft
**Author**: AI-assisted
**Skills**: `typescript`, `factory-function-composition`, `control-flow`, `method-shorthand-jsdoc`, `testing`

## Overview

Clean up `packages/workspace/src/workspace/create-document.ts` by inlining trivial helpers, deduplicating a repeated LIFO cleanup ceremony, and aligning the factory's internal layout with the codebase's four-zone convention. Evaluate whether document-related types should move out of the 1285-line `types.ts` bucket.

## Motivation

### Current State

`create-document.ts` (~400 lines) is the runtime document manager factory. It works correctly, but its internal organization drifts from the patterns the rest of the codebase follows.

**Hoisted trivial helpers that obscure intent:**

```typescript
// Top-level function, used only inside createDocuments — one-liner
function makeHandle(
  timeline: Timeline,
  extensions: Record<string, Extension<any>>,
): DocumentHandle {
  return Object.assign(timeline, { exports: extensions });
}
```

```typescript
// Private helper inside factory, trivial ternary — 2 call sites
function resolveGuid(input: TRow | string): string {
  if (typeof input === 'string') return input;
  return String(input[guidKey]);
}
```

**LIFO cleanup ceremony duplicated 5 times across 2 files:**

```typescript
// This ~10-line pattern appears in:
// 1. create-document.ts open() error path
// 2. create-document.ts close()
// 3. create-document.ts closeAll()
// 4. create-workspace.ts destroyLifo()      ← already extracted here
// 5. create-workspace.ts startDestroyLifo()  ← sync variant already here
const errors: unknown[] = [];
for (let i = destroys.length - 1; i >= 0; i--) {
  try {
    await destroys[i]?.();
  } catch (err) {
    errors.push(err);
  }
}
```

This creates problems:

1. **Unnecessary indirection**: `makeHandle` and `resolveGuid` force the reader to jump out of context for trivial operations. Both are one-liners called in 2 places each.
2. **Duplicated cleanup ceremony**: The LIFO destroy loop is copy-pasted 3 times in `create-document.ts` with minor variations (async vs sync, collect vs log errors). `create-workspace.ts` already has `destroyLifo()` and `startDestroyLifo()` as extracted utilities—`create-document.ts` should reuse them.
3. **Zone ordering drift**: The factory body has a private helper (`resolveGuid`) sandwiched between mutable state initialization and the return object, breaking the four-zone convention (immutable state → mutable state → private helpers → public API).
4. **Type bucket**: `types.ts` is 1285 lines mixing document, table, kv, awareness, extension, and workspace types. Document types account for ~10 type definitions that may be better co-located.

### Desired State

- `makeHandle` and `resolveGuid` inlined at call sites—fewer names, fewer jumps
- LIFO cleanup extracted to a shared utility, reused by both `create-document.ts` and `create-workspace.ts`
- Factory body reads top-to-bottom: config → state → return object
- Informed recommendation on document type co-location (move or keep, with reasoning)

## Research Findings

### LIFO Cleanup Locations

| File | Function/Location | Variant | Error Handling |
|---|---|---|---|
| `create-workspace.ts:70` | `destroyLifo()` | async, awaits each | Collects errors, returns array |
| `create-workspace.ts:91` | `startDestroyLifo()` | sync, fire-and-forget | Logs via `console.error` |
| `create-document.ts:263` | `open()` catch block | sync (inside try-catch) | Collects errors, logs if any, then rethrows original |
| `create-document.ts:357` | `close()` body | async, awaits each | Collects errors, throws aggregate |
| `create-document.ts:383` | `closeAll()` body | async, awaits each | Collects errors, logs via `console.error` |

**Key finding**: `destroyLifo` and `startDestroyLifo` in `create-workspace.ts` are already well-factored utilities. The three instances in `create-document.ts` are the same pattern with different error-reporting tails. Extracting the loop and letting call sites handle the returned errors array unifies all five locations.

**Implication**: Move `destroyLifo` and `startDestroyLifo` to `lifecycle.ts` (they're lifecycle cleanup primitives). Have `create-document.ts` import and reuse them. Call sites keep their own error-handling tails (throw, log, or rethrow).

### Document Types in `types.ts`

| Type | Line | Consumers (verify) |
|---|---|---|
| `DocumentConfig` | 163 | `define-table.ts`, `create-workspace.ts`, `types.ts` internal |
| `DocumentExtensionRegistration` | 192 | `create-document.ts`, `create-workspace.ts` |
| `DocumentHandle` | 267 | `create-document.ts`, re-exported from `index.ts` |
| `Documents` | 292 | `create-document.ts`, `create-workspace.ts`, re-exported |
| `HasDocuments` | 324 | `types.ts` internal (used by `DocumentsHelper`) |
| `DocumentsOf` | 336 | `types.ts` internal (used by `DocumentsHelper`) |
| `DocumentsHelper` | 360 | `create-workspace.ts`, re-exported |
| `ExtractAllDocumentTags` | 216 | `types.ts` internal (used by builder type) |
| `StringKeysOf` | 228 | `define-table.ts` |
| `ClaimedDocumentColumns` | 243 | `define-table.ts` |

**Key finding**: Several types are used only within `types.ts` itself or by `define-table.ts` (the builder chain). The consumer-facing types (`DocumentHandle`, `Documents`, `DocumentsHelper`) are re-exported from `index.ts`. Moving them requires updating re-exports but doesn't risk circular deps since the flow is `types.ts` → `create-document.ts` → `create-workspace.ts` (one direction).

**Implication**: This is an evaluation item—verify the import graph before deciding. The agent should research and recommend, not blindly move.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Inline `makeHandle` | Inline at 2 call sites | One-liner `Object.assign`; named function hides a trivial operation |
| Inline `resolveGuid` | Inline at 2 call sites | Trivial ternary; `const guid = ...` at top of each method is clearer |
| LIFO cleanup location | Move to `lifecycle.ts` | Already the home for lifecycle primitives (`defineExtension`, `Lifecycle`, `MaybePromise`) |
| Type co-location | Evaluate, don't move yet | Need import graph verification first; report recommendation in Review section |
| `open()` extraction | Evaluate after other changes | 130 lines currently; may read fine after cleanup. Only extract if genuinely clearer |

## Implementation Plan

### Phase 1: Extract shared LIFO cleanup

- [x] **1.1** Move `destroyLifo()` and `startDestroyLifo()` from `create-workspace.ts` to `lifecycle.ts`
- [x] **1.2** Update `create-workspace.ts` to import from `lifecycle.ts`
- [x] **1.3** Replace the LIFO loops in `create-document.ts` `close()` and `closeAll()` with `destroyLifo()`
- [x] **1.4** Replace the sync LIFO loop in `create-document.ts` `open()` error path with `startDestroyLifo()`
  > **Note**: Also replaced the async LIFO loop in `open()`'s `whenReady` catch with `destroyLifo()`—the spec research table missed this 4th instance.
- [x] **1.5** Verify error-handling semantics are preserved—`close()` throws aggregate, `closeAll()` logs, `open()` rethrows original

### Phase 2: Inline trivial helpers

- [x] **2.1** Inline `makeHandle()`: replace 2 call sites with `Object.assign(timeline, { exports: resolvedExtensions }) as DocumentHandle`, delete the function and its JSDoc
  > **Note**: makeHandle had been consolidated to 1 call site (post-earlier refactor). Also removed unused `type Timeline` import.
- [x] **2.2** Inline `resolveGuid()`: replace 2 call sites with `const guid = typeof input === 'string' ? input : String(input[guidKey])`, delete the function and its JSDoc
- [x] **2.3** Remove the now-unused `DocEntry` comment about `resolveGuid` if any references remain
  > **Note**: No stale references found—clean deletion.
- [x] **2.4** Run tests

### Phase 3: Reorder factory zones

- [x] **3.1** After inlining, verify `createDocuments` body reads as: config destructuring → `openDocuments` Map → `unobserveTable` observer → return object. No private helpers between state and return.
  > **Note**: After deleting `resolveGuid` (which was sandwiched between `openDocuments` and `unobserveTable`), the zones read correctly without any moves needed.
- [x] **3.2** If `unobserveTable` is not adjacent to `openDocuments`, move it. Both are zone 2 (mutable state / initialization).
  > **Note**: Already adjacent after resolveGuid removal. No move needed.
- [x] **3.3** Run tests

### Phase 4: Evaluate and report

- [ ] **4.1** Research the import graph for the 10 document-related types in `types.ts`—use `lsp_find_references` on each
- [ ] **4.2** Determine which types are internal-only vs re-exported for consumers
- [ ] **4.3** Write recommendation in Review section: move, partially move, or leave with rationale
- [ ] **4.4** Re-read `open()` method after all changes. If still >100 lines and the extension resolution loop (tag filtering + factory invocation + incremental context) is a self-contained concern, extract it as a private helper. Otherwise leave it and note why in Review.

## Edge Cases

### LIFO error semantics divergence

1. `close()` collects errors and throws an aggregate `Error` with count
2. `closeAll()` collects errors and logs them via `console.error` (does not throw)
3. `open()` error path collects cleanup errors, logs them, then rethrows the original factory error

These tails MUST remain different after extracting the shared loop. The shared `destroyLifo()` returns an error array—each call site handles it in its own way.

### `makeHandle` type assertion

`Object.assign(timeline, { exports: extensions })` returns `Timeline & { exports: ... }`. The current function has an explicit return type annotation `: DocumentHandle`. When inlining, ensure the `as DocumentHandle` cast (or equivalent type satisfaction) is preserved so TypeScript doesn't widen the return type.

### `resolveGuid` and `closeAll`

`closeAll()` doesn't call `resolveGuid`—it iterates the `openDocuments` Map directly by key. Only `open()` and `close()` use `resolveGuid`. Verify this before inlining to avoid creating a third inline site that doesn't exist.

## Open Questions

1. **Should `destroyLifo` accept an error handler callback instead of returning an array?**
   - Options: (a) return `unknown[]` and let call sites decide, (b) accept `onError?: (err: unknown) => void` callback, (c) return a discriminated result
   - **Recommendation**: Keep (a)—return the array. It's already the pattern in `create-workspace.ts` and keeps the utility pure. Call sites are 3 lines of error handling; a callback wouldn't save much.

2. **Should document types move to a `document-types.ts` or into `create-document.ts` itself?**
   - This depends on the import graph research in Phase 4. If types like `DocumentConfig` are imported by `define-table.ts` (the builder), putting them in `create-document.ts` would create a backward dependency. A standalone `document-types.ts` avoids this.
   - **Recommendation**: Defer until Phase 4 findings. Don't move anything without evidence.

3. **Should `open()` become method shorthand with `this.close()` internally?**
   - Currently `open`, `close`, `closeAll` are defined as properties on a `const documents` object literal. The `close` method could potentially call `this.close()` if the object used method shorthand.
   - **Recommendation**: Not in this refactor. The current object-literal-with-arrow-functions pattern works and the methods don't call each other (except `closeAll` could theoretically call `close`, but doesn't—it does its own loop for performance). Leave for a future pass if method shorthand would enable JSDoc improvements.

## Success Criteria

- [ ] All existing tests pass without modification: `bun test packages/workspace/src/workspace/create-document.test.ts`
- [ ] All existing tests pass: `bun test packages/workspace/src/workspace/create-workspace.test.ts`
- [ ] `lsp_diagnostics` clean on all changed files
- [ ] No behavior changes—pure refactor, no API changes, no new exports
- [ ] LIFO cleanup ceremony exists in exactly one location (`lifecycle.ts`), imported by both consumer files
- [ ] `makeHandle` and `resolveGuid` no longer exist as named functions
- [ ] Factory zones in `createDocuments` read top-to-bottom without private helpers between state and return
- [ ] Review section documents findings on type co-location and `open()` complexity
- [ ] One logical commit per phase

## References

- `packages/workspace/src/workspace/create-document.ts` — primary refactor target
- `packages/workspace/src/workspace/create-document.test.ts` — tests that must pass, do not modify
- `packages/workspace/src/workspace/create-workspace.ts` — consumer of `createDocuments`, has `destroyLifo`/`startDestroyLifo` to extract
- `packages/workspace/src/workspace/lifecycle.ts` — destination for shared LIFO utilities
- `packages/workspace/src/workspace/types.ts` — 1285-line type file with document types to evaluate
- `packages/workspace/src/workspace/index.ts` — re-exports to check when evaluating type moves
- `packages/workspace/src/workspace/define-table.ts` — imports `DocumentConfig`, `StringKeysOf`, `ClaimedDocumentColumns`

## Review

_To be filled after implementation: summary of changes, type co-location findings, `open()` complexity assessment, and suggestions for future work._
