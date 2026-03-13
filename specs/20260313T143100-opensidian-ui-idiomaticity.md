# OpenSidian UI Idiomaticity

**Date**: 2026-03-13
**Status**: In Progress
**Author**: AI-assisted

## Overview

Fix specific non-idiomatic patterns in OpenSidian's UI where hand-written markup reimplements existing shadcn-svelte primitives from `@epicenter/ui`. These are targeted, mechanical fixes—not new features.

## Motivation

### Current State

OpenSidian has 10 components built on `@epicenter/ui` primitives (Collapsible, ContextMenu, Dialog, AlertDialog, Breadcrumb, Button, Resizable, ScrollArea, Separator). The overall structure is sound, but several components bypass available primitives with manual implementations.

**Problem 1: Raw `<input>` with reimplemented styling**

`CreateDialog.svelte` and `RenameDialog.svelte` use raw `<input>` elements with manually copied shadcn classes:

```svelte
<!-- CreateDialog.svelte line 49 -->
<input
  class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
  type="text"
  placeholder="my-file.md"
  bind:value={name}
  autofocus
>
```

This is literally the `Input` component's class string copy-pasted. If the design system updates Input styling, these dialogs won't pick up the change.

**Problem 2: Inline SVG icons**

`TreeNode.svelte` defines SVG icons inline (ChevronRight, Folder, FolderOpen, File). Each is 5–10 lines of SVG markup hardcoded in the template. The monorepo already uses icon components elsewhere.

**Problem 3: Missing `Textarea` component**

`ContentEditor.svelte` uses a raw `<textarea>` with manual styling instead of the `Textarea` component from `@epicenter/ui/textarea`.

**Problem 4: No form field structure**

`CreateDialog.svelte` and `RenameDialog.svelte` lack label/error patterns. The `@epicenter/ui/field` component provides label + description + error message layouts, but neither dialog uses it.

### Desired State

Every form element, icon, and interactive primitive uses the corresponding `@epicenter/ui` component. Zero hand-written CSS class strings that duplicate existing components.

## Research Findings

### Available Primitives in `@epicenter/ui`

Checked `packages/ui/src/` for components that should be used but aren't:

| Component | Path | Currently Used? | Should Be Used In |
|---|---|---|---|
| `Input` | `@epicenter/ui/input` | No | `CreateDialog`, `RenameDialog` |
| `Textarea` | `@epicenter/ui/textarea` | No | `ContentEditor` |
| `Field` | `@epicenter/ui/field` | No | `CreateDialog`, `RenameDialog` |
| `Label` | `@epicenter/ui/label` | No | `CreateDialog`, `RenameDialog` |
| `Empty` | `@epicenter/ui/empty` | No | `FileTree` empty state |
| `Kbd` | `@epicenter/ui/kbd` | No | Keyboard shortcut hints |
| `Spinner` | `@epicenter/ui/spinner` | No | Loading states |
| `Tooltip` | `@epicenter/ui/tooltip` | No | Toolbar button hints |

**Key finding**: 8 available primitives are unused. The most impactful are `Input` (fixes 2 dialogs), `Textarea` (fixes the editor), and `Tooltip` (improves toolbar UX).

### Icon Strategy

The codebase doesn't have a centralized icon library dependency in OpenSidian. shadcn-svelte projects typically use `lucide-svelte`. Icons currently used inline in TreeNode:

- ChevronRight (expand/collapse indicator)
- Folder (closed folder)
- FolderOpen (expanded folder)
- File (generic file)

These are all standard Lucide icons.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Icon library | `lucide-svelte` | Standard for shadcn-svelte; already used in other shadcn ecosystems |
| Form inputs | `Input` from `@epicenter/ui/input` | Direct 1:1 replacement, no behavior change |
| Editor textarea | `Textarea` from `@epicenter/ui/textarea` | Direct replacement; richer editor is a separate spec |
| Form structure | `Field` + `Label` for dialogs | Provides consistent label/error layout |
| Empty states | `Empty` from `@epicenter/ui/empty` | Consistent empty state pattern |
| Toolbar hints | `Tooltip` on toolbar buttons | Buttons currently have no labels/hints |

## Implementation Plan

### Phase 1: Replace Raw Inputs (Quick wins)

- [x] **1.1** Replace `<input>` in `CreateDialog.svelte` with `Input` from `@epicenter/ui/input`
- [x] **1.2** Replace `<input>` in `RenameDialog.svelte` with `Input` from `@epicenter/ui/input`
- [x] **1.3** Wrap input fields in `Field` + `Label` for proper form structure
- [x] **1.4** Replace `<textarea>` in `ContentEditor.svelte` with `Textarea` from `@epicenter/ui/textarea`

### Phase 2: Replace Inline SVGs with Icon Components

- [x] **2.1** Add `lucide-svelte` to `apps/opensidian` dependencies
- [x] **2.2** Replace inline ChevronRight SVG in `TreeNode.svelte` with `<ChevronRight>` from lucide-svelte
- [x] **2.3** Replace inline Folder/FolderOpen SVGs with `<Folder>` / `<FolderOpen>`
- [x] **2.4** Replace inline File SVG with `<FileIcon>` (aliased to avoid name collision)
- [x] **2.5** Replace any remaining inline SVGs in `Toolbar.svelte` or other components
  > **Note**: Toolbar.svelte has no inline SVGs—it uses text-only Button components. No changes needed.

### Phase 3: Add Missing Primitives

- [ ] **3.1** Add `Tooltip` wrappers on Toolbar buttons (New File, New Folder, Rename, Delete, Load Sample Data)
- [ ] **3.2** Replace the "No files yet" empty state in `FileTree.svelte` with `Empty` component
- [ ] **3.3** Add `Kbd` hints where keyboard shortcuts exist (Ctrl+S in editor, Enter to submit dialogs)

## Edge Cases

### Autofocus on Dialog Open

The current raw `<input autofocus>` relies on native autofocus. The `Input` component from shadcn-svelte may need explicit focus management. Verify that:
1. `CreateDialog` focuses the name input when opened
2. `RenameDialog` focuses and selects the existing name when opened

### ContentEditor Textarea Sizing

The current `<textarea>` uses `resize: vertical` and fills the available height. The `Textarea` component may need the same sizing overrides. Keep the existing layout behavior.

## Open Questions

1. **Should we add `lucide-svelte` directly or create a thin icon wrapper in `@epicenter/ui`?**
   - Options: (a) Direct `lucide-svelte` import in OpenSidian, (b) Create `@epicenter/ui/icons` that re-exports Lucide icons
   - **Recommendation**: (a) — direct import. Icon wrapping adds indirection without clear benefit. Other apps can import lucide-svelte independently.

2. **Should `ContentEditor` remain a `Textarea` or should it use a richer editor?**
   - This spec deliberately limits scope to replacing the raw `<textarea>` with the shadcn `Textarea`. A richer editor (CodeMirror, TipTap) is a separate feature spec.
   - **Recommendation**: Defer rich editor to the Feature Additions spec. Fix the primitive here.

## Success Criteria

- [ ] Zero raw `<input>` or `<textarea>` elements—all use `@epicenter/ui` components
- [ ] Zero inline SVG icons—all use `lucide-svelte` components
- [ ] Toolbar buttons have tooltips showing their action
- [ ] Dialog form fields have proper labels
- [ ] Empty state uses the `Empty` component
- [ ] Visual appearance is identical (no regressions)—these are primitive swaps, not redesigns
- [ ] `svelte-check` passes with no new errors

## References

- `apps/opensidian/src/lib/components/CreateDialog.svelte` — raw `<input>` on line 49
- `apps/opensidian/src/lib/components/RenameDialog.svelte` — raw `<input>` on line 42
- `apps/opensidian/src/lib/components/ContentEditor.svelte` — raw `<textarea>`
- `apps/opensidian/src/lib/components/TreeNode.svelte` — inline SVGs on lines 81–151
- `apps/opensidian/src/lib/components/Toolbar.svelte` — toolbar buttons without tooltips
- `apps/opensidian/src/lib/components/FileTree.svelte` — empty state
- `packages/ui/src/input/` — Input component
- `packages/ui/src/textarea/` — Textarea component
- `packages/ui/src/field/` — Field component
- `packages/ui/src/tooltip/` — Tooltip component
- `packages/ui/src/empty/` — Empty component
