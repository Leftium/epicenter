# Button and Link Tooltip Integration

## Problem

Currently, adding tooltips to buttons requires using `WhisperingButton`, a wrapper component that combines `Button` + `WhisperingTooltip`. This has several issues:

1. **Verbose API**: Requires a separate component import and usage pattern
2. **Padding issues**: `Button` with `variant="link"` still has default size padding (`px-4 py-2`), requiring manual override with `class="h-fit p-0"` for inline usage
3. **Inconsistent patterns**: 98 usages of `WhisperingButton` across 20+ files, each requiring the wrapper
4. **No Link equivalent**: The `Link` component has no tooltip support at all

## Solution

Add an optional `tooltip` prop to both `Button` and `Link` components in `packages/ui`. When provided, the component automatically wraps itself with a tooltip.

## Implementation

### Button Component Changes

**File:** `packages/ui/src/button/button.svelte`

Add optional tooltip prop:

```typescript
type ButtonProps = WithElementRef<HTMLButtonAttributes> &
  WithElementRef<HTMLAnchorAttributes> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    tooltip?: string;  // NEW
  };
```

Implementation pattern:

```svelte
{#if tooltip}
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {#snippet child({ props: tooltipProps })}
          <!-- Existing button/anchor rendering, merging tooltipProps -->
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content class="max-w-xs text-center">
        {tooltip}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  <!-- Existing button/anchor rendering (unchanged) -->
{/if}
```

### Link Component Changes

**File:** `packages/ui/src/link/link.svelte`

Same pattern as Button:

```svelte
<script lang="ts">
  import { cn } from '#/utils/utils';
  import * as Tooltip from '#/tooltip';
  import type { HTMLAnchorAttributes } from 'svelte/elements';

  let {
    children,
    class: className,
    tooltip,  // NEW
    ...rest
  }: HTMLAnchorAttributes & { tooltip?: string } = $props();
</script>

{#if tooltip}
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {#snippet child({ props: tooltipProps })}
          <a
            {...rest}
            {...tooltipProps}
            class={cn('text-foreground font-medium underline underline-offset-4', className)}
          >
            {@render children?.()}
          </a>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content class="max-w-xs text-center">
        {tooltip}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  <a {...rest} class={cn('text-foreground font-medium underline underline-offset-4', className)}>
    {@render children?.()}
  </a>
{/if}
```

### Add `size="inline"` to Button

Add a new size variant for inline usage:

```typescript
size: {
  default: "h-9 px-4 py-2 has-[>svg]:px-3",
  sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
  lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
  icon: "size-9",
  "icon-sm": "size-8",
  "icon-lg": "size-10",
  inline: "h-auto p-0",  // NEW - for inline text buttons
},
```

## Migration

### Before (WhisperingButton)

```svelte
<script>
  import WhisperingButton from '$lib/components/WhisperingButton.svelte';
</script>

<WhisperingButton
  tooltipContent="Go to settings"
  href="/settings"
  variant="ghost"
  size="icon"
>
  <SettingsIcon />
</WhisperingButton>
```

### After (Button with tooltip)

```svelte
<script>
  import { Button } from '@epicenter/ui/button';
</script>

<Button
  tooltip="Go to settings"
  href="/settings"
  variant="ghost"
  size="icon"
>
  <SettingsIcon />
</Button>
```

### Inline Link Example

```svelte
<!-- Before -->
{' '}<WhisperingButton
  tooltipContent="Go to shortcut settings"
  href="/settings/shortcuts"
  variant="link"
  class="h-fit p-0"
>
  <kbd>Space</kbd>
</WhisperingButton>{' '}

<!-- After -->
{' '}<Link tooltip="Go to shortcut settings" href="/settings/shortcuts">
  <kbd>Space</kbd>
</Link>{' '}
```

## Migration Plan

### Phase 1: Update packages/ui
- [x] Add `tooltip` prop to `Button` component
- [x] Add `tooltip` prop to `Link` component
- [x] Add `size="inline"` variant to Button
- [x] Export updated types

### Phase 2: Migrate WhisperingButton usages
Files to update (98 usages across 20+ files):
- [x] `+page.svelte` (home) - 13 usages
- [x] `+layout.svelte` (config) - 15 usages
- [x] `global-shortcut/+page.svelte` - 5 usages
- [x] `desktop-app/+page.svelte` - 5 usages
- [x] `transformations/*.svelte` - multiple files
- [x] `recordings/*.svelte` - multiple files
- [x] `NavItems.svelte` - 11 usages
- [x] Various settings selectors
- [x] `CopyToClipboardButton.svelte`
- [x] `OpenFolderButton.svelte`

### Phase 3: Cleanup
- [x] Remove `WhisperingButton.svelte`
- [x] Remove `WhisperingTooltip.svelte`
- [x] Update any remaining direct Tooltip usages

## Notes

- The tooltip prop accepts a simple string. For more complex tooltip content (snippets), users can still use the Tooltip components directly.
- Screen reader text (`<span class="sr-only">`) that WhisperingButton adds should be evaluated - it may be redundant with the tooltip's accessible name.
- WhisperingTooltip has `class="max-w-xs text-center"` on the content - this should be preserved in the new implementation.

## Review

### Summary

Successfully migrated all 98+ usages of `WhisperingButton` to the new pattern where `Button` and `Link` components have an optional `tooltip` prop. The wrapper components `WhisperingButton.svelte` and `WhisperingTooltip.svelte` have been deleted.

### Changes Made

1. **packages/ui/src/button/button.svelte**: Added `tooltip?: string` prop and `size="inline"` variant. When tooltip is provided, the button is wrapped with Tooltip components using a snippet pattern.

2. **packages/ui/src/link/link.svelte**: Added `tooltip?: string` prop with the same wrapper pattern.

3. **Migrated files**:
   - Home page (`+page.svelte`): Changed inline kbd shortcuts to use `Link` with `class="no-underline"` for cleaner semantics
   - Config layout and pages: Direct `tooltipContent` → `tooltip` prop migration
   - All selector components (CompressionSelector, ManualDeviceSelector, RecordingModeSelector, TranscriptionSelector, TransformationSelector, VadDeviceSelector)
   - NavItems, OpenFolderButton, CopyToClipboardButton
   - Transformation editor components (Configuration, Runs)
   - FFmpeg command builder, ShortcutFormatHelp, CompressionBody

4. **WhisperingTooltip usages**: Two files used `WhisperingTooltip` directly with custom snippets (RecordingRowActions, TextPreviewDialog). These were refactored to use the Tooltip components directly with proper nesting.

5. **Deleted files**:
   - `apps/whispering/src/lib/components/WhisperingButton.svelte`
   - `apps/whispering/src/lib/components/WhisperingTooltip.svelte`

### Pattern Details

The Button component uses a snippet pattern to conditionally wrap content:

```svelte
{#snippet buttonContent(tooltipProps?: Record<string, unknown>)}
  {#if href}
    <a ... {...tooltipProps}>{@render children?.()}</a>
  {:else}
    <button ... {...tooltipProps}>{@render children?.()}</button>
  {/if}
{/snippet}

{#if tooltip}
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          {@render buttonContent(props)}
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content class="max-w-xs text-center">
        {tooltip}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  {@render buttonContent()}
{/if}
```

### Benefits

- Simpler API: No need to import a separate `WhisperingButton` component
- Cleaner inline usage: `Link` with tooltip is cleaner than `Button variant="link" class="h-fit p-0"`
- Consistent styling: Tooltip content always has `class="max-w-xs text-center"`
- Reduced code: Two wrapper components eliminated
