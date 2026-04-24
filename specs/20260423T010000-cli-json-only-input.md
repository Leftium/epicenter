# CLI: JSON-Only Input, Remove Schema-to-Flags Bridge

**Date**: 2026-04-23
**Status**: Draft (blocked on `specs/20260422T234500-unified-action-invocation.md` Phase 5)
**Author**: AI-assisted

## Overview

Strip the docs and ask what `run` actually is: **dispatch an action by dot-path with a JSON payload.** That's the Invoke cell of the CLI's grid — local or via `--peer`, same verb. Generating a flag-based UI from the action's schema is a different product (an interactive form builder), and that product isn't what the CLI is.

Concretely: remove `packages/cli/src/util/typebox-to-yargs.ts` and the schema-driven flag generation in `epicenter run`. Input arrives as JSON only — inline positional, `@file.json`, or stdin. The TypeBox schema on each action still validates input, but validation runs inside the action wrapper (per the unified-action-invocation spec), not in the CLI.

## Motivation

### Current State

`run.ts` converts a TypeBox schema to yargs options at command-build time, so users can pass flat-schema fields as flags:

```bash
epicenter run tabManager.tabs.close --tab-ids 1 2 3
```

### Problems

1. **Bridge layer silently accumulates edge cases.** Nested objects, unions, refinements, `anyOf`/`allOf`, custom string formats — each has to be mapped to yargs semantics or produce surprising behavior.
2. **Two validation layers.** The CLI converts string flags to values guessing at types, then the action wrapper re-validates against the schema. Bugs hide in the seam.
3. **CLI interactive use is rare in practice.** Scripts and CI invocations pipe JSON or read a file; humans who want ergonomics write a TypeScript script that calls `ws.actions.x.y(input)` directly.
4. **`typebox-to-yargs.ts` is ~200 lines that only serves the flat-schema interactive case.**

### Desired State

```bash
# Inline JSON
epicenter run tabManager.tabs.close '{"tabIds":[1,2,3]}'

# File
epicenter run tabManager.tabs.close @input.json
epicenter run tabManager.tabs.close --file input.json

# Stdin
echo '{"tabIds":[1,2,3]}' | epicenter run tabManager.tabs.close
```

All three work today. The flag form becomes the only change — removed, not replaced.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Input transport | JSON (inline, file, stdin) | Already supported; sole path forward. |
| Schema-driven flags | Removed | Bridge layer churn, two validation surfaces. |
| Validation | Delegated to action wrapper | Single source of truth; behavior matches RPC and direct local calls. |
| Error on unknown flags | yargs strict mode stays on for `--peer`/`--workspace`/`--file`/`--format`; other flags produce error | Fails fast, no silent drop. |
| Migration path | Note in README + release notes | Small behavior change; low-impact user base today. |

## Implementation Plan

- [ ] **1** Delete `packages/cli/src/util/typebox-to-yargs.ts`.
- [ ] **2** Simplify `packages/cli/src/commands/run.ts`:
    - Remove the `typeboxToYargsOptions(action.input)` call and the flag-merging loop.
    - Input resolution keeps only: positional (inline JSON or `@file.json`), `--file`, stdin.
- [ ] **3** Update CLI tests to drop flag-based cases.
- [ ] **4** Update documentation: `apps/*/README.md` examples switch to JSON form; note the removal in the release.
- [ ] **5** Error messaging: when user passes flags we don't recognize, yargs's default "unknown argument" message is already good.

## Edge Cases

1. **Script that used flag form** — fails with yargs "unknown argument." User switches to JSON. Release note covers migration.
2. **Action with no input schema** — JSON input is ignored if no schema; or passed as opaque `{}` and handler ignores. Wrapper validates only when schema is present.
3. **Empty stdin** — treated as no input. Handler with required input fails validation inside the wrapper.

## Success Criteria

- [ ] `packages/cli/src/util/typebox-to-yargs.ts` deleted.
- [ ] `run.ts` no longer depends on TypeBox at all.
- [ ] All existing CLI tests updated or removed; new tests cover the three input modes.
- [ ] Example invocations in every `README.md` use JSON form.

## References

- `packages/cli/src/commands/run.ts:105-138` — `resolveInput` (positional / file / stdin / flags)
- `packages/cli/src/util/typebox-to-yargs.ts` — to delete
- `packages/cli/src/util/parse-input.ts` — keep; handles JSON parsing
- `specs/20260422T234500-unified-action-invocation.md` — prerequisite (Phase 2 invariant #4 makes wrapper validation unconditional, which closes the CLI's validation gap)
