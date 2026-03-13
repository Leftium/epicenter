# Branded ID Convention: Three-Part Pattern

## Problem

Branded ID types in the codebase lack a consistent construction pattern. Currently:

- The **type** (`type SavedTabId = string & Brand<'SavedTabId'>`) exists everywhere
- The **arktype validator** (`const SavedTabId = type('string').pipe(...)`) exists for types used in `defineTable()` schemas
- **No factory function** exists—every call site uses the ugly double-cast: `generateId() as string as SavedTabId`

The double-cast is error-prone (easy to forget the intermediate `as string`), inconsistent with `packages/filesystem` which already has factories (`generateRowId`, `generateColumnId`), and scattered across 7+ call sites.

## Convention

Every branded ID type that is generated at runtime MUST follow the three-part pattern:

```typescript
import { type Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId } from '@epicenter/workspace';

// 1. TYPE — the branded type itself
export type SavedTabId = string & Brand<'SavedTabId'>;

// 2. VALIDATOR — arktype pipe for schema composition in defineTable()
export const SavedTabId = type('string').pipe(
    (s): SavedTabId => s as SavedTabId,
);

// 3. FACTORY — create* prefix, encapsulates the cast
export const createSavedTabId = (): SavedTabId =>
    generateId() as string as SavedTabId;
```

### Naming Rules

| Part | Naming | Example |
|------|--------|---------|
| Type | PascalCase | `SavedTabId` |
| Validator | Same PascalCase (TypeScript allows type+value same name) | `SavedTabId` |
| Factory | `create` + PascalCase | `createSavedTabId` |

### When Each Part Is Needed

| Part | Required When |
|------|--------------|
| Type | Always — this IS the branded type |
| Validator | Used in `defineTable()` or other arktype schemas |
| Factory | IDs are generated at runtime (via `generateId()` or similar) |

Not every branded type needs all three. Path types like `AbsolutePath`, `ProjectDir` are cast from external sources—they need only the type. Composite IDs like `TabCompositeId` already have `createTabCompositeId()` factories.

---

## Inventory of Branded IDs Requiring `create*` Factories

### apps/tab-manager/src/lib/workspace.ts

| Type | Has Type | Has Validator | Has Factory | Needs Factory | Call Sites |
|------|----------|---------------|-------------|---------------|------------|
| `DeviceId` | ✅ | ✅ | ❌ | ❌ (set from external source) | — |
| `SavedTabId` | ✅ | ✅ | ❌ | ✅ | tab-actions.ts:104, saved-tab-state.svelte.ts:93 |
| `BookmarkId` | ✅ | ✅ | ❌ | ✅ | bookmark-state.svelte.ts:84 |
| `ConversationId` | ✅ | ✅ | ❌ | ✅ | chat-state.svelte.ts:87 |
| `ChatMessageId` | ✅ | ✅ | ❌ | ✅ | chat-state.svelte.ts:361 |
| `TabCompositeId` | ✅ | ✅ | ✅ (`createTabCompositeId`) | — | Already done |
| `WindowCompositeId` | ✅ | ✅ | ✅ (`createWindowCompositeId`) | — | Already done |
| `GroupCompositeId` | ✅ | ✅ | ✅ (`createGroupCompositeId`) | — | Already done |

### packages/filesystem/src/ids.ts (already follows this convention)

| Type | Has Type | Has Validator | Has Factory |
|------|----------|---------------|-------------|
| `FileId` | ✅ | ✅ | ✅ (`generateFileId`) |
| `RowId` | ✅ | ❌ | ✅ (`generateRowId`) |
| `ColumnId` | ✅ | ❌ | ✅ (`generateColumnId`) |

### packages/workspace/src/shared/id.ts (already follows this convention)

| Type | Has Type | Has Validator | Has Factory |
|------|----------|---------------|-------------|
| `Id` | ✅ | ❌ | ✅ (`generateId`) |
| `Guid` | ✅ | ❌ | ✅ (`generateGuid`) |

---

## Implementation Plan

### Wave 1: Add factory functions (workspace.ts)

- [ ] Add `createSavedTabId` to `apps/tab-manager/src/lib/workspace.ts`
- [ ] Add `createBookmarkId` to `apps/tab-manager/src/lib/workspace.ts`
- [ ] Add `createConversationId` to `apps/tab-manager/src/lib/workspace.ts`
- [ ] Add `createChatMessageId` to `apps/tab-manager/src/lib/workspace.ts`

### Wave 2: Replace double-casts at call sites

- [ ] `apps/tab-manager/src/lib/tab-actions.ts:104` — `generateId() as string as SavedTabId` → `createSavedTabId()`
- [ ] `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts:93` — same
- [ ] `apps/tab-manager/src/lib/state/bookmark-state.svelte.ts:84` — `generateId() as string as BookmarkId` → `createBookmarkId()`
- [ ] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:87` — `generateId() as string as ConversationId` → `createConversationId()`
- [ ] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:361` — `generateId() as string as ChatMessageId` → `createChatMessageId()`

### Wave 3: Update skills and documentation

- [ ] Update `.agents/skills/typescript/SKILL.md` — branded types section to document `create*` factory convention
- [ ] Update `.agents/skills/workspace-api/SKILL.md` — branded table IDs section to use factories instead of double-casts
- [ ] Update JSDoc on each factory function with `@example` blocks

---

## Review

_To be filled after implementation._
