# Remove "Serialized" Terminology

**Status:** Draft
**Created:** 2026-01-06
**Author:** Technical Writer
**Branch:** `chore/remove-serialized-terminology`

## Overview

Following the [JSON-Serializable Rows Architecture](./20260106T000000-json-serializable-rows.md), the distinction between "live" and "serialized" values has vanished. In the current system, `CellValue` is identical to `SerializedCellValue`, and a `Row` object's internal data shape is identical to what was previously called a `SerializedRow`.

This specification outlines the removal of the misleading "Serialized" terminology across the Epicenter codebase to reflect this new reality.

## Problem Statement

The "Serialized" terminology implies a transformation or conversion process (e.g., converting a CRDT type to a plain JS type). Since we moved to ID-referenced rich content and plain JS types for all row data, no such conversion happens.

Maintaining these separate types and function names:

1. **Creates cognitive load**: Developers have to wonder if they should use the "serialized" or "live" version.
2. **Obscures reality**: It suggests a complexity that no longer exists.
3. **Bloats the API**: Extra types and utility functions that are just identity operations.

## Proposed Solution

We will perform a codebase-wide refactor to eliminate "Serialized" from our type names and utility functions.

### 1. Type Refactoring

| Old Name               | New Name         | Action                                                    |
| ---------------------- | ---------------- | --------------------------------------------------------- |
| `SerializedCellValue`  | `CellValue`      | Delete `SerializedCellValue`, use `CellValue` everywhere. |
| `SerializedRow`        | `RowData`        | Rename to reflect it's the "plain data" shape of a row.   |
| `PartialSerializedRow` | `PartialRowData` | Rename accordingly.                                       |

### 2. Function Refactoring

- **Delete `serializeCellValue()`**: Since it is now an identity function (`(v) => v`), it should be removed. Calls to it should be replaced with the value itself.
- **Simplify `Row.toJSON()`**: This method currently returns `SerializedRow`. It should return `RowData`. Since the internal state of a `Row` is already in this shape, it becomes a simple clone or even just a getter if appropriate.

### 3. Implementation Plan

- [ ] **Core Schema Updates**
  - [ ] Update `packages/epicenter/src/core/schema/fields/types.ts`
  - [ ] Delete `packages/epicenter/src/core/schema/runtime/serialization.ts`
  - [ ] Update `packages/epicenter/src/core/schema/index.ts` exports
- [ ] **Core Logic Updates**
  - [ ] Update `packages/epicenter/src/core/kv/core.ts` (remove `serializeCellValue` calls)
  - [ ] Update `packages/epicenter/src/core/tables/table-helper.ts` (rename types, remove `serializeCellValue` calls, update `toJSON`)
  - [ ] Update `packages/epicenter/src/core/utils/yjs.ts` (rename `updateYRowFromSerializedRow` → `updateYRowFromRowData`)
- [ ] **Provider Updates**
  - [ ] Update Markdown provider (`configs.ts`, `markdown-provider.ts`)
  - [ ] Update SQLite provider (`sqlite-provider.ts`)
- [ ] **App & Example Updates**
  - [ ] Update `apps/tab-manager`
  - [ ] Update `examples/content-hub`
- [ ] **Public API Updates**
  - [ ] Update `packages/epicenter/src/index.shared.ts` exports

## Files to Change

| File Path                                                        | Description of Changes                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/epicenter/src/core/schema/fields/types.ts`             | Update type definitions, remove `SerializedCellValue`.           |
| `packages/epicenter/src/core/schema/runtime/serialization.ts`    | **Delete** - no longer needed.                                   |
| `packages/epicenter/src/core/schema/index.ts`                    | Update exports to remove serialization utilities.                |
| `packages/epicenter/src/core/kv/core.ts`                         | Remove calls to `serializeCellValue`.                            |
| `packages/epicenter/src/core/tables/table-helper.ts`             | Rename `SerializedRow` → `RowData`, remove `serializeCellValue`. |
| `packages/epicenter/src/core/utils/yjs.ts`                       | Rename types and update `updateYRowFromSerializedRow`.           |
| `packages/epicenter/src/providers/markdown/configs.ts`           | Update type references.                                          |
| `packages/epicenter/src/providers/markdown/markdown-provider.ts` | Update type references.                                          |
| `packages/epicenter/src/providers/sqlite/sqlite-provider.ts`     | Update type references.                                          |
| `packages/epicenter/src/index.shared.ts`                         | Update public exports.                                           |
| `apps/tab-manager/src/lib/epicenter/browser.schema.ts`           | Update type references.                                          |

## Migration Notes

This is a **breaking change** for any external consumers or internal apps that rely on the `SerializedCellValue`, `SerializedRow`, or `PartialSerializedRow` type names.

**Migration Path:**

1. Replace `SerializedCellValue` with `CellValue`.
2. Replace `SerializedRow` with `RowData`.
3. Replace `PartialSerializedRow` with `PartialRowData`.
4. Remove calls to `serializeCellValue(value)` and use `value` directly.

## Benefits

1. **Simpler Mental Model**: No more distinction between "serialized" and "live" row data.
2. **Cleaner Code**: Fewer types to maintain and fewer utility functions to import.
3. **Truth in Naming**: The code accurately reflects that we are working with plain JavaScript data objects that are already serializable.

## Review Summary

(To be completed after implementation)
