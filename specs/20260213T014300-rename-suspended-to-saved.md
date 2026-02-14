# Rename "Suspended" to "Saved" Terminology

**Date**: 2026-02-13
**Status**: Draft

## Overview

Rename all "suspend/suspended" terminology to "save/saved" across the tab manager app. The user-facing label becomes **"Save for later"** and the code/data model uses **"saved"**.

## Motivation

"Suspend" is the wrong term for what this feature does. In browser land, "suspend" means freezing a tab in place to save memory (like The Great Suspender) — the tab stays in the tab bar but stops consuming resources. Our feature actually **closes the tab and persists it for later retrieval**, which is saving, not suspending.

Evidence: the current helper text already says _"Suspend tabs to save them for later"_ — using a second phrase to explain what the first word means. If the verb needs explaining, it's the wrong verb.

"Save for later" is universally understood (Slack uses this exact phrase), requires zero learning curve, and works for both developer and non-developer audiences.

## Terminology Mapping

| Before (Suspended)                    | After (Saved)                          | Where                         |
| ------------------------------------- | -------------------------------------- | ----------------------------- |
| "Suspended Tabs"                      | "Saved Tabs"                           | Section header                |
| "No suspended tabs"                   | "No saved tabs"                        | Empty state                   |
| "Suspend tabs to save them for later" | "Save tabs to come back to them later" | Empty state helper            |
| "Suspend" (tooltip)                   | "Save for later" (tooltip)             | TabItem action button         |
| "Error loading suspended tabs"        | "Error loading saved tabs"             | Error state                   |
| "Restore"                             | "Restore"                              | **No change** — still correct |
| "Delete"                              | "Delete"                               | **No change**                 |
| "Restore All"                         | "Restore All"                          | **No change**                 |
| "Delete All"                          | "Delete All"                           | **No change**                 |

## Code Rename Mapping

### Types & Schema (`browser.schema.ts`)

| Before                         | After                      |
| ------------------------------ | -------------------------- | ------------- |
| `SuspendedTab` (type)          | `SavedTab`                 |
| `suspendedTabs` (table const)  | `savedTabs`                |
| `BROWSER_TABLES.suspendedTabs` | `BROWSER_TABLES.savedTabs` |
| `suspendedAt` (field)          | `savedAt`                  |
| `sourceDeviceId` (field)       | `sourceDeviceId`           | **No change** |
| JSDoc: "Suspended tabs table"  | "Saved tabs table"         |

### Helpers (`suspend-tab.ts` -> `save-tab.ts`)

| Before                          | After               |
| ------------------------------- | ------------------- | ------------- |
| File: `suspend-tab.ts`          | File: `save-tab.ts` |
| `suspendTab()`                  | `saveTab()`         |
| `restoreTab()`                  | `restoreTab()`      | **No change** |
| `deleteSuspendedTab()`          | `deleteSavedTab()`  |
| `updateSuspendedTab()`          | `updateSavedTab()`  |
| All JSDoc referencing "suspend" | Updated to "save"   |

### Query Layer (`suspended-tabs.ts` -> `saved-tabs.ts`)

| Before                                             | After                                  |
| -------------------------------------------------- | -------------------------------------- |
| File: `suspended-tabs.ts`                          | File: `saved-tabs.ts`                  |
| `suspendedTabsKeys`                                | `savedTabsKeys`                        |
| `suspendedTabsKeys.all` = `['suspended-tabs']`     | `savedTabsKeys.all` = `['saved-tabs']` |
| `SuspendedTabsErr` / `'SuspendedTabsError'`        | `SavedTabsErr` / `'SavedTabsError'`    |
| `suspendedTabs` (export)                           | `savedTabs`                            |
| `suspendedTabs.suspend` mutation                   | `savedTabs.save`                       |
| Mutation key `['suspended-tabs', 'suspend']`       | `['saved-tabs', 'save']`               |
| All other mutation keys: `'suspended-tabs'` prefix | `'saved-tabs'` prefix                  |
| Error messages: "Failed to suspend tab"            | "Failed to save tab"                   |

### Component (`SuspendedTabList.svelte` -> `SavedTabList.svelte`)

| Before                          | After                       |
| ------------------------------- | --------------------------- |
| File: `SuspendedTabList.svelte` | File: `SavedTabList.svelte` |
| Imports from `suspended-tabs`   | Imports from `saved-tabs`   |
| `type SuspendedTab`             | `type SavedTab`             |
| `suspendedTabs.getAll`          | `savedTabs.getAll`          |
| `suspendedTabs.restore`         | `savedTabs.restore`         |
| `suspendedTabs.remove`          | `savedTabs.remove`          |
| `suspendedTabs.restoreAll`      | `savedTabs.restoreAll`      |
| `suspendedTabs.removeAll`       | `savedTabs.removeAll`       |
| `suspendedTabsKeys`             | `savedTabsKeys`             |
| `tab.suspendedAt`               | `tab.savedAt`               |

### TabItem (`TabItem.svelte`)

| Before                  | After                                          |
| ----------------------- | ---------------------------------------------- |
| `suspendMutation`       | `saveMutation`                                 |
| `suspendedTabs.suspend` | `savedTabs.save`                               |
| `suspendedTabsKeys`     | `savedTabsKeys`                                |
| `tooltip="Suspend"`     | `tooltip="Save for later"`                     |
| `PauseIcon`             | Consider `BookmarkIcon` or `ArchiveIcon` — TBD |

### Other Files

| File                         | Change                                               |
| ---------------------------- | ---------------------------------------------------- |
| `App.svelte`                 | Import `SavedTabList` instead of `SuspendedTabList`  |
| `lib/epicenter/index.ts`     | Export `SavedTab` instead of `SuspendedTab`          |
| `lib/epicenter/workspace.ts` | Update JSDoc referencing `suspendedTabs`             |
| `lib/query/index.ts`         | Import/export `savedTabs` instead of `suspendedTabs` |

## Icon Change

Current: `PauseIcon` (pause symbol, fits "suspend" metaphor)

Options for "save":

- `BookmarkIcon` — universally means "save for later", strong precedent
- `ArchiveIcon` (box with arrow) — feels too permanent
- `InboxIcon` — implies a queue/inbox metaphor
- `SaveIcon` (floppy disk) — dated, means "save file" not "save for later"

**Recommendation**: `BookmarkIcon` — it's the standard "save for later" icon across Slack, browsers, and mobile apps.

## Data Migration

**Not required — but Y.Doc keys must stay unchanged.** The Yjs table key is derived from the JS object key name via `TableKey(name)` → `table:suspendedTabs`. Field names like `suspendedAt` are also Y.Map keys in the CRDT. Renaming either would orphan existing data. **Decision: keep internal Y.Doc keys (`suspendedTabs`, `suspendedAt`) unchanged, rename all code variables, types, file names, and user-facing strings.**

## Implementation Plan

- [ ] **1. Verify data migration** — Confirm `defineTable` key derivation doesn't depend on variable name
- [ ] **2. Schema rename** — `browser.schema.ts`: rename type, table const, field `suspendedAt` -> `savedAt`, update JSDoc
- [ ] **3. Helper rename** — Rename `suspend-tab.ts` -> `save-tab.ts`, rename all functions and update JSDoc
- [ ] **4. Query layer rename** — Rename `suspended-tabs.ts` -> `saved-tabs.ts`, rename all exports, keys, error types
- [ ] **5. SavedTabList component** — Rename `SuspendedTabList.svelte` -> `SavedTabList.svelte`, update all imports and labels
- [ ] **6. TabItem component** — Rename mutation, update tooltip to "Save for later", change icon to `BookmarkIcon`
- [ ] **7. Remaining imports** — Update `App.svelte`, `index.ts`, `workspace.ts`, `query/index.ts`
- [ ] **8. Update original spec** — Add note to `20260213T003200-suspended-tabs.md` that terminology was renamed
- [ ] **9. Verify** — `bun run check` passes, no stale references to "suspend" terminology

## Edge Cases

### Yjs Table Key

If the table key in Y.Doc is derived from the variable name `suspendedTabs`, renaming to `savedTabs` would create a new empty table while orphaning existing data. **Must verify before proceeding.** If keys are positional or explicitly set, no migration needed.

### Existing Suspended Tabs in User Data

Users who already have suspended tabs should see them appear as "Saved Tabs" after the update. This works automatically if the underlying Y.Doc key doesn't change.

## Success Criteria

- [ ] Zero references to "suspend" terminology in user-facing text
- [ ] Zero references to `suspended`/`Suspended`/`suspend` in code (except the background.ts WebSocket comment which is unrelated)
- [ ] All existing saved tabs still appear after the rename
- [ ] `bun run check` passes clean
