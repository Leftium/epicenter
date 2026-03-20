# Browser State: Chrome as Sole Authority (v2)

**Status**: In Progress
**Supersedes**: `20260319T120000-browser-state-chrome-authority.md` (reverted by merge)

## Motivation

`browser-state.svelte.ts` is ~890 lines because it dual-writes to SvelteMap AND Y.Doc for every browser event, runs Y.Doc observers that call Chrome APIs for remote changes, and needs echo detection to break the cycle. Live browser tabs don't need CRDT persistence—Chrome IS the authority. Only user-created data (saved tabs, bookmarks, chat) needs Y.Doc.

## Design Principles (learned from v1)

1. **Use Chrome's types directly.** `BrowserTab = Browser.tabs.Tab & { id: number }`. No manual type declarations, no converter functions that create new objects. Just a narrowing guard that asserts `id` is defined.
2. **No field renames.** Chrome calls it `tab.id` and `window.id`. So do we. The old `tabId`/`windowId` rename was a Y.Doc artifact (avoiding collision with composite string IDs).
3. **Only carry what consumers read.** v1 audit found `groupId`, `openerTabId`, `status`, `incognito`, `type` are stored but never read. Don't store them—but since we pass through Chrome's object directly (no converter), they're on the object anyway. The TYPE just narrows `id`.
4. **Converters become guards.** `toBrowserTab` → `narrowTab`: no object creation, just null-check `id` and type-assert.

## Target Architecture

```
LIVE TABS (ephemeral)
─────────────────────
Chrome ──events──► narrowTab() ──► SvelteMap<number, WindowState> ──► UI
                   (type guard)          │
                                         ├── windows     ($derived)
                                         └── tabsByWindow(id)

Actions: browserState.close(id) ──► browser.tabs.remove() ──► onRemoved event ──► SvelteMap update
         (all actions call Chrome API; events close the loop)


PERSISTENT DATA (Y.Doc, unchanged)
──────────────────────────────────
User action ──► Y.Doc table ──► fromTable() ──► $derived ──► UI
                     │
                sync + persist
```

## Type System

```typescript
// The entire type system for live browser state:
export type BrowserTab = Browser.tabs.Tab & { id: number };
export type BrowserWindow = Browser.windows.Window & { id: number };

// Narrowing guards (no object creation):
function narrowTab(tab: Browser.tabs.Tab): BrowserTab | null {
  if (tab.id == null || tab.id === TAB_ID_NONE) return null;
  return tab as BrowserTab;
}

function narrowWindow(win: Browser.windows.Window): BrowserWindow | null {
  if (win.id == null) return null;
  return win as BrowserWindow;
}
```

Consumers use Chrome's field names directly: `tab.id`, `tab.url`, `tab.title`, `window.id`, `window.focused`. Optional fields (`title?: string`, `url?: string`, `audible?: boolean`) are handled at call sites—most already use `??`, `?.`, or truthiness checks.

## Implementation Plan

### Phase 1: Core rewrite (`browser-state.svelte.ts`)

**Remove:**
- ALL `workspace`/`tables` imports and usage
- ALL Y.Doc seed logic (diff against existing rows, prune stale entries)
- ALL Y.Doc observers (`_unobserveTabs`, `_unobserveWindows`, `_unobserveTabGroups`)
- ALL `// Y.Doc write` lines in event handlers
- ALL `authState.status` checks in event handlers (Y.Doc artifact—Chrome events fire regardless)
- `recentlyAddedTabIds` echo detection
- `row-converters` imports
- Composite ID imports
- Device registration from this file
- `whenReadyPromise` `$state` wrapper (just use the raw promise)

**Keep:**
- `SvelteMap<number, WindowState>` keyed by Chrome's native window `id`
- `whenReady` promise (gates UI, only awaits `browser.windows.getAll({ populate: true })`)
- All browser event listeners (SvelteMap writes only)
- All action methods (close, activate, pin, unpin, mute, unmute, reload, duplicate)
- Same public API shape

**New types (2 lines):**
```typescript
export type BrowserTab = Browser.tabs.Tab & { id: number };
export type BrowserWindow = Browser.windows.Window & { id: number };
```

**Event handler pattern:**
```typescript
browser.tabs.onCreated.addListener((tab) => {
  if (!seeded) return;
  const bt = narrowTab(tab);
  if (!bt) return;
  windowStates.get(bt.windowId)?.tabs.set(bt.id, bt);
});
```

**`windows` getter uses `$derived` for caching** (not recomputed on every access).

**Target: ~200 lines.**

### Phase 2: Clean up `workspace.ts`

**Remove:**
- `tabsTable`, `windowsTable`, `tabGroupsTable` definitions
- These tables from the `tables` object in `defineWorkspace`
- `TabCompositeId`, `WindowCompositeId`, `GroupCompositeId` branded types
- `createTabCompositeId`, `createWindowCompositeId`, `createGroupCompositeId`
- `parseTabId`, `parseWindowId`, `parseGroupId`
- `parseCompositeIdInternal`
- `nativeTabId`, `toNativeIds`
- `Tab`, `Window`, `TabGroup` type exports
- `TAB_ID_NONE`, `TAB_GROUP_ID_NONE` constants (browser-state has its own)
- `tabGroupColor` type
- `findDuplicateGroups`, `groupTabsByDomain` imports
- Query actions that read from removed tables: `tabs.search`, `tabs.list`, `tabs.findDuplicates`, `tabs.dedup`, `tabs.groupByDomain`, `windows.list`, `domains.count`
- `trySync` import (only used by removed actions)

**Update:**
- Mutation actions (`tabs.close`, `tabs.open`, `tabs.activate`, `tabs.save`, `tabs.group`, `tabs.pin`, `tabs.mute`, `tabs.reload`) — accept native `number` IDs instead of composite strings. Remove `getDeviceId`/`toNativeIds` dance from handlers (except `tabs.save` which still needs `getDeviceId` for `sourceDeviceId`).

**Keep:**
- `devicesTable`, `savedTabsTable`, `bookmarksTable`, `conversationsTable`, `chatMessagesTable`, `toolTrustTable`
- `DeviceId`, `SavedTabId`, `BookmarkId`, `ConversationId`, `ChatMessageId` types
- All workspace extensions (persistence, broadcast, sync)
- `devices.list` query action

**Add:**
- `registerDevice()` exported function (moved from browser-state seed)

### Phase 3: Delete `row-converters.ts`

The file only has `tabToRow`, `windowToRow`, `tabGroupToRow`. All removed. Delete entirely.

### Phase 4: Update consumers

All changes are mechanical renames. The public API shape is identical.

| File | Change |
|---|---|
| `unified-view-state.svelte.ts` | `Window` → `BrowserWindow`, `Tab` → `BrowserTab`, `WindowCompositeId` → `number`, `.windowId` → `.id` (on windows), import from browser-state |
| `UnifiedTabList.svelte` | `item.window.windowId` → `item.window.id`, `item.tab.tabId` → `item.tab.id` |
| `TabItem.svelte` | `Tab` → `BrowserTab`, `tab.tabId` → `tab.id`, import from browser-state |
| `command-palette/items.ts` | Remove `TabCompositeId`/`parseTabId` imports, remove `compositeToNativeIds`, `t.tabId` → `t.id`, `w.windowId` → `w.id`, fix `savedTabState.actions.save(tab)` → `savedTabState.save(tab)` |
| `saved-tab-state.svelte.ts` | `type Tab` → `type BrowserTab` from browser-state, `save(tab: Tab)` → `save(tab: BrowserTab)`, `tab.tabId` → `tab.id` |
| `bookmark-state.svelte.ts` | Same as saved-tab-state |
| `tab-helpers.ts` | `TabLike.tabId` → `TabLike.id`, unexport `normalizeUrl` (internal only), replace `trySync` with plain try/catch, fix examples |
| `App.svelte` | Add `registerDevice()` call after `workspaceClient.whenReady` |

### Phase 5: Handle `title.localeCompare` in items.ts sort

With Chrome's types, `tab.title` is `string | undefined`. The sort in the "Sort Tabs by Title" command needs:
```typescript
(a.title ?? '').localeCompare(b.title ?? '')
```

## Critical Constraints

- **DO NOT** change `chat-state.svelte.ts` or `tool-trust.svelte.ts`
- **DO NOT** change workspace extensions (persistence, broadcast, sync)
- `saved-tab-state.svelte.ts` and `bookmark-state.svelte.ts` get type-only changes (import + parameter type)
- Match existing code style: tabs for indentation, em dashes closed (no spaces), JSDoc on exports
- Use `SvelteMap` from `svelte/reactivity`
- Use `$derived` for the `windows` getter (not recomputed on every access)

## Verification

1. `lsp_diagnostics` on all changed files (only pre-existing WXT worktree errors acceptable)
2. No new TypeScript errors
3. Saved tabs, bookmarks, chat completely unaffected

## Migration Checklist

- [x] Rewrite `browser-state.svelte.ts` (~200 lines, Chrome types directly)
  > Rewrote from 894 → 361 lines. Removed all Y.Doc writes, observers, composite IDs,
  > row-converters, echo detection, authState.status checks, duplicate event handlers.
  > Added BrowserTab/BrowserWindow intersection types and narrowing guards.
- [ ] Clean up `workspace.ts` (remove browser tables, composite IDs, broken queries)
- [x] Delete `row-converters.ts`
  > Already deleted (previous attempt cleaned up by merge).
- [x] Update `unified-view-state.svelte.ts`
  > `.windowId` → `.id` on all BrowserWindow property accesses.
- [x] Update `UnifiedTabList.svelte`
  > `.windowId` → `.id`, `.tabId` → `.id` in getKey and template.
- [x] Update `TabItem.svelte`
  > `tab.tabId` → `tab.id` in derived.
- [x] Update `command-palette/items.ts`
  > `.tabId` → `.id`, `.windowId` → `.id`, added `(a.title ?? '').localeCompare(b.title ?? '')`.
- [x] Update `saved-tab-state.svelte.ts` (type only)
  > `Tab` → `BrowserTab` from browser-state, `.tabId` → `.id`.
- [x] Update `bookmark-state.svelte.ts` (type only)
  > `Tab` → `BrowserTab` from browser-state.
- [x] Update `tab-helpers.ts`
  > `TabLike.tabId` → `TabLike.id`.
- [x] Update `App.svelte` (device registration)
  > Added `registerDevice()` call in onMount. Function added to workspace.ts.
- [ ] Verify diagnostics clean
