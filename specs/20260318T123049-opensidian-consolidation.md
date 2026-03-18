# Opensidian: Factory Consolidation & File Reorganization

## Overview

Reduce duplication and improve organization in `apps/opensidian/`. Five changes ordered by dependency.

## Changes

### 1. Consolidate Dialog State into fsState

**Problem**: CreateDialog, RenameDialog, DeleteConfirmation are instantiated in both FileTreeItem.svelte (per tree node!) and Toolbar.svelte. That's 7 duplicate `$state(false)` declarations, 7 duplicate helper functions, and potentially hundreds of dialog instances.

**Solution**:
- Add dialog open/close state + mode to `fsState` (zone 2 mutable state)
- Add `openCreate(mode, parentId?)`, `openRename()`, `openDelete()` to `fsState.actions`
- Add read-only getters for dialog state to the return object
- Move all 3 dialog instances to AppShell.svelte (rendered once)
- Remove dialog imports, state, helpers, and instances from FileTreeItem.svelte and Toolbar.svelte
- FileTreeItem context menu and Toolbar buttons call `fsState.actions.openCreate('file')` etc.

**Files changed**:
- `src/lib/fs/fs-state.svelte.ts` — add dialog state + actions
- `src/lib/components/AppShell.svelte` — render dialogs once
- `src/lib/components/FileTreeItem.svelte` — remove dialog state/instances, call fsState.actions
- `src/lib/components/Toolbar.svelte` — remove dialog state/instances, call fsState.actions
- `src/lib/components/CreateDialog.svelte` — read open/mode from fsState instead of props
- `src/lib/components/RenameDialog.svelte` — read open from fsState instead of props
- `src/lib/components/DeleteConfirmation.svelte` — read open from fsState instead of props

### 2. Extract withToast Error Handling Wrapper

**Problem**: 6 actions in fsState have identical try/catch/toast.error/console.error patterns.

**Solution**:
- Add a private `withToast` helper inside `createFsState()` (zone 3 private helpers)
- Refactor createFile, createFolder, deleteFile, rename, readContent, writeContent to use it

**Files changed**:
- `src/lib/fs/fs-state.svelte.ts` — add helper, refactor 6 actions

### 3. Add walkTree Utility to fsState

**Problem**: FileTree.svelte and CommandPalette.svelte both implement recursive tree traversal with the same getChildIds→getRow→recurse pattern.

**Solution**:
- Add a `walkTree` method to fsState that accepts a visitor callback
- Refactor FileTree.svelte `visibleIds` to use it
- Refactor CommandPalette.svelte `allFiles` to use it

**Files changed**:
- `src/lib/fs/fs-state.svelte.ts` — add walkTree method
- `src/lib/components/FileTree.svelte` — use walkTree
- `src/lib/components/CommandPalette.svelte` — use walkTree

### 4. Reorganize Files by Concern

**Problem**: All 13 components are flat in `components/`. As the app grows, the grouping by concern becomes important.

**Solution**:
```
src/lib/
  state/
    fs-state.svelte.ts         # Moved from fs/
  utils/
    file-icons.ts              # Moved from fs/
  components/
    AppShell.svelte            # Stays at root
    Toolbar.svelte             # Stays at root
    CommandPalette.svelte      # Stays at root
    tree/
      FileTree.svelte
      FileTreeItem.svelte
    editor/
      ContentPanel.svelte
      ContentEditor.svelte
      CodeMirrorEditor.svelte
      TabBar.svelte
      PathBreadcrumb.svelte
    dialogs/
      CreateDialog.svelte
      RenameDialog.svelte
      DeleteConfirmation.svelte
```

All imports updated to use `$lib/state/`, `$lib/utils/`, and new component paths.

**Files changed**: All files (import path updates)

### 5. Add idToPath Reverse Map in @epicenter/filesystem

**Problem**: `getPathForId(id)` iterates ALL paths linearly. The `selectedPath` derived does the same. O(n) per lookup.

**Solution**:
- Add `idToPath` reverse map to `createFileSystemIndex` in `packages/filesystem/src/tree/path-index.ts`
- Expose `getPathById(id)` method on FileSystemIndex
- Use it in fsState's `getPathForId` and `selectedPath`

**Files changed**:
- `packages/filesystem/src/tree/path-index.ts` — add reverse map + method
- `packages/filesystem/src/tree/index.ts` — re-export if needed
- `apps/opensidian/src/lib/fs/fs-state.svelte.ts` — use new O(1) lookup

## Task List

- [ ] 1a. Add dialog state (zone 2) + getters to fs-state.svelte.ts
- [ ] 1b. Add dialog open actions (openCreate, openRename, openDelete) to fs-state.svelte.ts
- [ ] 1c. Refactor CreateDialog.svelte to read state from fsState
- [ ] 1d. Refactor RenameDialog.svelte to read state from fsState
- [ ] 1e. Refactor DeleteConfirmation.svelte to read state from fsState
- [ ] 1f. Move dialog instances to AppShell.svelte
- [ ] 1g. Strip dialog code from FileTreeItem.svelte
- [ ] 1h. Strip dialog code from Toolbar.svelte
- [ ] 2a. Add withToast helper to fs-state.svelte.ts
- [ ] 2b. Refactor 6 actions to use withToast
- [ ] 3a. Add walkTree method to fs-state.svelte.ts
- [ ] 3b. Refactor FileTree.svelte visibleIds to use walkTree
- [ ] 3c. Refactor CommandPalette.svelte allFiles to use walkTree
- [ ] 4a. Move fs-state.svelte.ts to state/ and file-icons.ts to utils/
- [ ] 4b. Create tree/, editor/, dialogs/ directories and move components
- [ ] 4c. Update all imports across all files
- [ ] 5a. Add idToPath reverse map + getPathById to path-index.ts
- [ ] 5b. Update fsState to use O(1) path lookups
- [ ] Final: Run diagnostics and verify build

## Review

_(To be filled after implementation)_
