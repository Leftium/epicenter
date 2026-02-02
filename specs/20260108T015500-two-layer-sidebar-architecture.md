# Two-Layer Sidebar Architecture

**Created**: 2026-01-08T01:55:00
**Status**: In Progress

## Problem

The current sidebar implementation has a UX disconnect:

- Workspaces are hidden in a dropdown menu in the header
- The sidebar says "All Workspaces" but doesn't actually list them
- Tables and settings only appear when inside a workspace
- There's no clear visual distinction between "root view" and "workspace view"

## Solution

Implement a two-layer sidebar architecture using SvelteKit layout groups:

1. **HomeSidebar**: Shown at root (`/`), lists all workspaces as menu items
2. **WorkspaceSidebar**: Shown inside workspaces (`/workspaces/[id]/*`), shows tables and settings

## Route Structure

### Before

```
src/routes/
├ +layout.svelte              # Everything: providers + sidebar + dialogs
├ +page.svelte                # Home page
└ workspaces/
  └ [id]/
    ├ +page.svelte
    ├ tables/[tableId]/+page.svelte
    └ settings/[key]/+page.svelte
```

### After

```
src/routes/
├ +layout.svelte              # Base: providers + dialogs (NO sidebar)
├ (home)/
│ ├ +layout.svelte            # HomeSidebar layout
│ └ +page.svelte              # "/" - all workspaces
└ (workspace)/
  └ workspaces/
    └ [id]/
      ├ +layout.svelte        # WorkspaceSidebar layout
      ├ +page.svelte          # "/workspaces/[id]"
      ├ tables/
      │ └ [tableId]/
      │   └ +page.svelte      # "/workspaces/[id]/tables/[tableId]"
      └ settings/
        └ [key]/
          └ +page.svelte      # "/workspaces/[id]/settings/[key]"
```

## Component Structure

### HomeSidebar.svelte

Location: `src/lib/components/HomeSidebar.svelte`

- Lists all workspaces as `Sidebar.MenuItem` entries
- "New Workspace" button
- Footer with "Open Data Folder"

### WorkspaceSidebar.svelte

Location: `src/lib/components/WorkspaceSidebar.svelte`

- Header with workspace name/switcher dropdown
- "All Workspaces" back link
- Tables group (collapsible)
- Settings group (collapsible)
- Footer with "Open Data Folder"

## Layout Responsibilities

### Root `+layout.svelte`

- QueryClientProvider
- Dialogs (InputDialog, CreateTableDialog, CreateWorkspaceDialog, ConfirmationDialog)
- Toaster
- ModeWatcher
- NO sidebar - just renders children

### `(home)/+layout.svelte`

- Sidebar.Provider
- HomeSidebar
- Sidebar.Inset with header + main

### `(workspace)/workspaces/[id]/+layout.svelte`

- Sidebar.Provider
- WorkspaceSidebar
- Sidebar.Inset with header + main

## Files to Create

- [ ] `src/routes/(home)/+layout.svelte`
- [ ] `src/routes/(home)/+page.svelte`
- [ ] `src/routes/(workspace)/workspaces/[id]/+layout.svelte`
- [ ] `src/routes/(workspace)/workspaces/[id]/+page.svelte`
- [ ] `src/routes/(workspace)/workspaces/[id]/tables/[tableId]/+page.svelte`
- [ ] `src/routes/(workspace)/workspaces/[id]/settings/[key]/+page.svelte`
- [ ] `src/lib/components/HomeSidebar.svelte`
- [ ] `src/lib/components/WorkspaceSidebar.svelte`

## Files to Modify

- [ ] `src/routes/+layout.svelte` - Remove sidebar, keep providers

## Files to Delete

- [ ] `src/routes/+page.svelte` (moved to (home))
- [ ] `src/routes/workspaces/` (moved to (workspace))
- [ ] `src/lib/components/app-sidebar.svelte`
- [ ] `src/lib/components/WorkspaceSwitcher.svelte`

## Review

### Changes Made

1. **Root `+layout.svelte`**: Simplified to only contain shared providers (QueryClientProvider, dialogs, Toaster, ModeWatcher) - no sidebar

2. **New `(home)/` layout group**:
   - `+layout.svelte`: Contains Sidebar.Provider + HomeSidebar + Sidebar.Inset wrapper
   - `+page.svelte`: All workspaces grid view (moved from root)

3. **New `(workspace)/` layout group**:
   - `workspaces/[id]/+layout.svelte`: Contains Sidebar.Provider + WorkspaceSidebar + Sidebar.Inset wrapper with HeaderBreadcrumbs
   - `workspaces/[id]/+page.svelte`: Workspace overview
   - `workspaces/[id]/tables/[tableId]/+page.svelte`: Table detail view
   - `workspaces/[id]/settings/[key]/+page.svelte`: Settings detail view

4. **New sidebar components**:
   - `HomeSidebar.svelte`: Shows "Epicenter" header, lists all workspaces as menu items, "New Workspace" action, "Open Data Folder" footer
   - `WorkspaceSidebar.svelte`: Shows workspace name with dropdown switcher, "All Workspaces" back link, collapsible Tables and Settings groups, "Open Data Folder" footer

5. **Deleted files**:
   - `app-sidebar.svelte` (replaced by HomeSidebar + WorkspaceSidebar)
   - `WorkspaceSwitcher.svelte` (functionality moved into WorkspaceSidebar header)
   - Old route files in `routes/workspaces/`

### Build Status

- **Vite build**: ✅ Successful
- **TypeScript**: Pre-existing snippet type warnings remain (Svelte 5 issue with `{#snippet child({ props })}` destructuring)

### Route Structure After

```
src/routes/
├── +layout.svelte              # Base providers only
├── (home)/
│   ├── +layout.svelte          # HomeSidebar
│   └── +page.svelte            # "/" - workspaces grid
└── (workspace)/
    └── workspaces/
        └── [id]/
            ├── +layout.svelte  # WorkspaceSidebar
            ├── +page.svelte    # "/workspaces/[id]"
            ├── tables/
            │   └── [tableId]/
            │       └── +page.svelte
            └── settings/
                └── [key]/
                    └── +page.svelte
```

### UX Improvements

1. **Root view**: Workspaces are now first-class sidebar items (not hidden in dropdown)
2. **Workspace view**: Clear contextual sidebar with Tables/Settings groups
3. **Navigation**: "All Workspaces" link in workspace sidebar for easy back navigation
4. **Workspace switching**: Dropdown in workspace header for quick switching without leaving workspace context
