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

- [x] Add `createSavedTabId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `createBookmarkId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `createConversationId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `createChatMessageId` to `apps/tab-manager/src/lib/workspace.ts`

### Wave 2: Replace double-casts at call sites

- [x] `apps/tab-manager/src/lib/tab-actions.ts:179` — `generateId() as string as SavedTabId` → `createSavedTabId()`
- [x] `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts:93` — same
- [x] `apps/tab-manager/src/lib/state/bookmark-state.svelte.ts:84` — `generateId() as string as BookmarkId` → `createBookmarkId()`
- [x] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:87` — `generateConversationId` wrapper removed, replaced with `createConversationId()`
- [x] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:361` — `generateId() as string as ChatMessageId` → `createChatMessageId()`

### Wave 3: Update skills and documentation

- [x] Update `.agents/skills/typescript/SKILL.md` — branded types section to document `create*` factory convention
- [x] Update `.agents/skills/workspace-api/SKILL.md` — branded table IDs section to use factories instead of double-casts
- [x] Update JSDoc on each factory function with `@example` blocks

---

## Review

Three commits landed:

1. `feat(tab-manager): add create* factory functions for branded ID types` — added `generateId` import and 4 factories (`createSavedTabId`, `createBookmarkId`, `createConversationId`, `createChatMessageId`) co-located with their type+validator pairs in `workspace.ts`.
2. `refactor(tab-manager): replace double-cast ID generation with create* factories` — replaced all 5 double-cast call sites across 4 files. Removed the local `generateConversationId` wrapper in `chat-state.svelte.ts` and eliminated all `generateId` imports from consumer files.
3. `docs(tab-manager): add JSDoc with @example blocks to create* ID factories` — each factory has a description, `{@link}` to its branded type, and a realistic `@example` block.

4. `docs(skills): update typescript and workspace-api skills with branded ID factory convention` — completed the truncated three-part pattern section in typescript skill; refined the workspace-api skill's pattern section with factory-first examples and call-site guidance.
