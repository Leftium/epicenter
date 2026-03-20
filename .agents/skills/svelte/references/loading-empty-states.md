# Loading and Empty State Patterns

## When to Read This

Read when handling loading states, empty states, or error states in Svelte components—including `{#await}` blocks, conditional loading, and button spinners.

## Never Use Plain Text for Loading States

Always use the `Spinner` component from `@epicenter/ui/spinner` instead of plain text like "Loading...". This applies to:

- `{#await}` blocks gating on async readiness
- `{#if}` / `{:else}` conditional loading
- Button loading states

## Full-Page Loading (Async Gate)

When gating UI on an async promise (e.g. `whenReady`, `whenSynced`), use `Empty.*` for both loading and error states. This keeps the structure symmetric:

```svelte
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
</script>

{#await someState.whenReady}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Loading tabs…</Empty.Title>
	</Empty.Root>
{:then _}
	<MainContent />
{:catch}
	<Empty.Root class="flex-1">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load</Empty.Title>
		<Empty.Description>Something went wrong. Try reloading.</Empty.Description>
	</Empty.Root>
{/await}
```

## Inline Loading (Conditional)

When loading state is controlled by a boolean or null check:

```svelte
<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
</script>

{#if data}
	<Content {data} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
```

## Button Loading State

Use `Spinner` inside the button, matching the `AuthForm` pattern:

```svelte
<Button onclick={handleAction} disabled={isPending}>
	{#if isPending}<Spinner class="size-3.5" />{:else}Submit{/if}
</Button>
```

## Empty State (No Data)

Use the `Empty.*` compound component for empty states (no results, no items):

```svelte
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
</script>

<Empty.Root class="py-8">
	<Empty.Media>
		<FolderOpenIcon class="size-8 text-muted-foreground" />
	</Empty.Media>
	<Empty.Title>No items found</Empty.Title>
	<Empty.Description>Create an item to get started</Empty.Description>
</Empty.Root>
```

## Key Rules

- **Never** show plain text ("Loading...", "Loading tabs…") without a `Spinner`
- **Always** include `{:catch}` on `{#await}` blocks — prevents infinite spinner on failure
- Use `text-muted-foreground` for loading text and spinner color
- Use `size-5` for full-page spinners, `size-3.5` for inline/button spinners
- Match the `Empty.*` compound component pattern for both error and empty states
