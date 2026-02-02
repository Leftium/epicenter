# Schema Folder Consolidation Analysis

**Date**: 2026-01-06
**Status**: Analysis Complete - Recommendations Ready
**Branch**: `feat/temporal-intermediate-representation`

## Context

After migrating from `DateWithTimezone` factory function to `Temporal.ZonedDateTime`, we analyzed whether the `runtime/` folder could be consolidated into `fields/`.

## Current Structure

```
packages/epicenter/src/core/schema/
├── fields/
│   ├── factories.ts      # Field factory functions (id, text, date, select, etc.)
│   ├── types.ts          # Field schema type definitions
│   └── nullability.ts    # isNullableFieldSchema helper
├── runtime/
│   ├── date-with-timezone.ts  # Storage format types (DateWithTimezoneString)
│   ├── datetime.ts            # Temporal helpers (toDateTimeString, fromDateTimeString)
│   ├── regex.ts               # Validation regex patterns
│   └── regex.test.ts          # Regex tests
├── converters/
│   ├── to-arktype.ts
│   ├── to-arktype-yjs.ts
│   ├── to-drizzle.ts
│   └── ...
└── index.ts              # Main exports
```

## Analysis Results

### Recommendation: Keep `runtime/` Separate

**Reason**: `runtime/` is a shared primitive layer used by multiple parts of the system, not just `fields/`.

### Dependency Map

| Consumer                              | What it uses from `runtime/`                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fields/factories.ts`                 | `DATE_WITH_TIMEZONE_STRING_REGEX`, `Temporal`, `toDateTimeString`                                                                                              |
| `fields/types.ts`                     | `DateWithTimezoneString` (type only)                                                                                                                           |
| `converters/to-arktype.ts`            | `DateWithTimezoneString` (type only)                                                                                                                           |
| `providers/sqlite/schema/builders.ts` | `Temporal`, `toDateTimeString`, `fromDateTimeString`                                                                                                           |
| `index.shared.ts` (public API)        | `ISO_DATETIME_REGEX`, `TIMEZONE_ID_REGEX`, `DATE_WITH_TIMEZONE_STRING_REGEX`, `Temporal`, `toDateTimeString`, `fromDateTimeString`, `isDateWithTimezoneString` |

### Why Consolidation Would Be Wrong

1. **Architectural Separation**: `runtime/` contains primitives (regex, date formats) that are cross-cutting concerns
2. **Provider Dependencies**: SQLite provider directly imports from `runtime/datetime.ts` for custom column types
3. **Converter Dependencies**: `to-arktype.ts` imports `DateWithTimezoneString` type
4. **Public API**: Multiple exports from `runtime/` are part of the public package API

If we moved `runtime/` into `fields/`, then `providers/` and `converters/` would depend on `fields/`, breaking the "primitives at the bottom" architecture.

## Dead Code Analysis

### Confirmed Dead Code

| Export               | File       | Status                          | Action                            |
| -------------------- | ---------- | ------------------------------- | --------------------------------- |
| `ISO_DATETIME_REGEX` | `regex.ts` | Exported but unused in codebase | Consider removing from public API |

**Note**: `ISO_DATETIME_REGEX` is only used in its own test file. It was previously used by `isIsoDateTimeString()` which was removed.

### Breaking Change Found

**File**: `examples/content-hub/scripts/02-transform-dates.ts`

```typescript
import { isDateWithTimezoneString, isIsoDateTimeString } from '@epicenter/hq';
//                                  ^^^^^^^^^^^^^^^^^^^ REMOVED
```

**Action Required**: Update this script to either:

1. Use `ISO_DATETIME_REGEX.test(value)` directly
2. Remove the check if `isDateWithTimezoneString` is sufficient
3. Inline a simple ISO date check

## Potential Optimizations

### 1. Rename `runtime/` to `primitives/`

Better reflects its role as foundational utilities. Current name suggests "runtime-only" code.

### 2. Consolidate `date-with-timezone.ts` and `datetime.ts`

These are tightly coupled:

- `date-with-timezone.ts`: Types only (31 lines)
- `datetime.ts`: Conversion functions (45 lines)

Could become single `datetime.ts` with both types and functions.

### 3. Remove `ISO_DATETIME_REGEX` from Public API

It's not used anywhere in the codebase except tests. Consider:

- Keep internally for potential future use
- Remove from `index.ts` / `index.shared.ts` exports

### 4. Move `nullability.ts` to `runtime/`

The `isNullableFieldSchema` helper is a utility function, not a factory. Could live in `runtime/` (or renamed `primitives/`).

## Recommended Next Steps

### Immediate (This PR)

- [x] Commit current changes (done)
- [x] Fix breaking change in `examples/content-hub/scripts/02-transform-dates.ts`
  - Changed `isIsoDateTimeString(value)` to `ISO_DATETIME_REGEX.test(value)`

### Follow-up PR (Optional Cleanup)

- [ ] Consolidate `date-with-timezone.ts` + `datetime.ts` into single file
- [ ] Remove `ISO_DATETIME_REGEX` from public exports (keep internal)
- [ ] Consider renaming `runtime/` to `primitives/`

## File Reference

```
# Files analyzed
packages/epicenter/src/core/schema/runtime/date-with-timezone.ts  # 31 lines - types only
packages/epicenter/src/core/schema/runtime/datetime.ts            # 45 lines - Temporal helpers
packages/epicenter/src/core/schema/runtime/regex.ts               # 78 lines - validation patterns
packages/epicenter/src/core/schema/fields/factories.ts            # ~300 lines - field factories
packages/epicenter/src/core/schema/fields/types.ts                # 439 lines - type definitions
packages/epicenter/src/core/schema/fields/nullability.ts          # 29 lines - helper function
```

## Commits on This Branch

1. `feat(schema): use Temporal.ZonedDateTime as intermediate representation for dates`
2. `refactor(sqlite): simplify TDefault generics to static values only`
3. `docs(sqlite): restore JSDoc for column builder functions`
4. `refactor(schema): remove legacy DateWithTimezone code`
