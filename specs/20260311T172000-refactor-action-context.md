# Refactor: Separate concerns in `createActionContext`

## Problem

`createActionContext` bundles three unrelated concerns into one function:

1. **Tool creation** — converting workspace `Action` tree → TanStack AI `ClientTool[]`
2. **Schema stripping** — deriving server definitions (no `execute`) from client tools
3. **UI labels** — mapping action names → display strings (`{ active, done }`)

The API has three code smells:

- **`...toolOptions` spread** hides that only `requireApprovalForMutations` flows through. Adding fields to the top-level type silently passes them to internals.
- **Labels bundled with tool creation** — UI concern (ToolCallPart.svelte) stapled to an AI concern (ChatClient tools).
- **Pre-computed `definitions`** — eagerly strips tools at module init, consumed in a different file.

## Solution

Separate into independent exports. No god-object.

### Changes

#### `packages/ai/src/action-context.ts`

- Remove `createActionContext`
- Export `actionsToClientTools` (was private — now public, explicit options)
- Export `toServerDefinitions` (renamed from `toDefinitions` — now public)
- Keep `ActionLabel`, `ActionNames` types exported

#### `packages/ai/src/index.ts`

- Update barrel exports

#### `apps/tab-manager/src/lib/workspace.ts`

- Replace single `createActionContext(...)` call with:
  - `actionsToClientTools(workspaceClient.actions)` → `workspaceTools`
  - `toServerDefinitions(workspaceTools)` → `workspaceDefinitions`
  - Plain typed record → `workspaceLabels`
- Export each separately

#### `apps/tab-manager/src/lib/state/chat-state.svelte.ts`

- Import `workspaceTools`, `workspaceDefinitions` instead of `actionContext`

#### `apps/tab-manager/src/lib/components/chat/ToolCallPart.svelte`

- Import `workspaceLabels` instead of `actionContext`
- Direct record lookup instead of `getLabel()`

## Non-goals

- `@epicenter/ai` package stays — it's a valid bridge between `@epicenter/workspace` and `@tanstack/ai`
- No changes to the workspace action system itself
- No changes to TanStack AI types

## Review

- [ ] Pending
