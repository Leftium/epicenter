---
name: svelte
description: Svelte 5 patterns including TanStack Query mutations, SvelteMap reactive state, shadcn-svelte components, and component composition. Use when writing Svelte components, using TanStack Query, working with SvelteMap/fromTable/fromKv, or working with shadcn-svelte UI.
metadata:
  author: epicenter
  version: '1.0'
---

# Svelte Guidelines

> **Related Skills**: See `query-layer` for TanStack Query integration. See `styling` for CSS and Tailwind conventions.

## When to Apply This Skill

Use this pattern when you need to:

- Build Svelte 5 components that use TanStack Query mutations.
- Replace nested ternary `$derived` mappings with `satisfies Record` lookups.
- Decide between `createMutation` in `.svelte` and `.execute()` in `.ts`.
- Follow shadcn-svelte import, composition, and component organization patterns.
- Refactor one-off `handle*` wrappers into inline template actions.
- Convert SvelteMap data to arrays for derived state or component props.

# `$derived` Value Mapping: Use `satisfies Record`, Not Ternaries

When a `$derived` expression maps a finite union to output values, use a `satisfies Record` lookup. Never use nested ternaries. Never use `$derived.by()` with a switch just to map values.

```svelte
<!-- Bad: nested ternary in $derived -->
<script lang="ts">
	const tooltip = $derived(
		syncStatus.current === 'connected'
			? 'Connected'
			: syncStatus.current === 'connecting'
				? 'Connecting…'
				: 'Offline',
	);
</script>

<!-- Bad: $derived.by with switch for a pure value lookup -->
<script lang="ts">
	const tooltip = $derived.by(() => {
		switch (syncStatus.current) {
			case 'connected': return 'Connected';
			case 'connecting': return 'Connecting…';
			case 'offline': return 'Offline';
		}
	});
</script>

<!-- Good: $derived with satisfies Record -->
<script lang="ts">
	import type { SyncStatus } from '@epicenter/sync-client';

	const tooltip = $derived(
		({
			connected: 'Connected',
			connecting: 'Connecting…',
			offline: 'Offline',
		} satisfies Record<SyncStatus, string>)[syncStatus.current],
	);
</script>
```

Why `satisfies Record` wins:

- Compile-time exhaustiveness: add a value to the union and TypeScript errors on the missing key. Nested ternaries silently fall through.
- It's a data declaration, not control flow. The mapping is immediately visible.
- `$derived()` stays a single expression — no need for `$derived.by()`.

Reserve `$derived.by()` for multi-statement logic where you genuinely need a function body. For value lookups, keep it as `$derived()` with a record.

`as const` is unnecessary when using `satisfies`. `satisfies Record<T, string>` already validates shape and value types.

See `docs/articles/record-lookup-over-nested-ternaries.md` for rationale.

# Reactive Table State Pattern

When a factory function exposes workspace table data via `fromTable`, follow this three-layer convention:

```typescript
// 1. Map — reactive source (private, suffixed with Map)
const foldersMap = fromTable(workspaceClient.tables.folders);

// 2. Derived array — cached materialization (private, no suffix)
const folders = $derived(foldersMap.values().toArray());

// 3. Getter — public API (matches the derived name)
return {
	get folders() {
		return folders;
	},
};
```

Naming: `{name}Map` (private source) → `{name}` (cached derived) → `get {name}()` (public getter).

### With Sort or Filter

Chain operations inside `$derived` — the entire pipeline is cached:

```typescript
const tabs = $derived(tabsMap.values().toArray().sort((a, b) => b.savedAt - a.savedAt));
const notes = $derived(allNotes.filter((n) => n.deletedAt === undefined));
```

See the `typescript` skill for iterator helpers (`.toArray()`, `.filter()`, `.find()` on `IteratorObject`).

### Template Props

For component props expecting `T[]`, derive in the script block — never materialize in the template:

```svelte
<!-- Bad: re-creates array on every render -->
<FujiSidebar entries={entries.values().toArray()} />

<!-- Good: cached via $derived -->
<script>
	const entriesArray = $derived(entries.values().toArray());
</script>
<FujiSidebar entries={entriesArray} />
```
# Mutation Pattern Preference

## In Svelte Files (.svelte)

Always prefer `createMutation` from TanStack Query for mutations. This provides:

- Loading states (`isPending`)
- Error states (`isError`)
- Success states (`isSuccess`)
- Better UX with automatic state management

### The Preferred Pattern

Pass `onSuccess` and `onError` as the second argument to `.mutate()` to get maximum context:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import * as rpc from '$lib/query';

	// Wrap .options in accessor function, no parentheses on .options
	// Name it after what it does, NOT with a "Mutation" suffix (redundant)
	const deleteSession = createMutation(
		() => rpc.sessions.deleteSession.options,
	);

	// Local state that we can access in callbacks
	let isDialogOpen = $state(false);
</script>

<Button
	onclick={() => {
		// Pass callbacks as second argument to .mutate()
		deleteSession.mutate(
			{ sessionId },
			{
				onSuccess: () => {
					// Access local state and context
					isDialogOpen = false;
					toast.success('Session deleted');
					goto('/sessions');
				},
				onError: (error) => {
					toast.error(error.title, { description: error.description });
				},
			},
		);
	}}
	disabled={deleteSession.isPending}
>
	{#if deleteSession.isPending}
		Deleting...
	{:else}
		Delete
	{/if}
</Button>
```

### Why This Pattern?

- **More context**: Access to local variables and state at the call site
- **Better organization**: Success/error handling is co-located with the action
- **Flexibility**: Different calls can have different success/error behaviors

## In TypeScript Files (.ts)

Always use `.execute()` since createMutation requires component context:

```typescript
// In a .ts file (e.g., load function, utility)
const result = await rpc.sessions.createSession.execute({
	body: { title: 'New Session' },
});

const { data, error } = result;
if (error) {
	// Handle error
} else if (data) {
	// Handle success
}
```

## Exception: When to Use .execute() in Svelte Files

Only use `.execute()` in Svelte files when:

1. You don't need loading states
2. You're performing a one-off operation
3. You need fine-grained control over async flow

## Single-Use Functions: Inline or Document

If a function is defined in the script tag and used only once in the template, inline it at the call site. This applies to event handlers, callbacks, and any other single-use logic.

### Why Inline?

Single-use extracted functions add indirection — the reader jumps between the function definition and the template to understand what happens on click/keydown/etc. Inlining keeps cause and effect together at the point where the action happens.

```svelte
<!-- BAD: Extracted single-use function with no JSDoc or semantic value -->
<script>
	function handleShare() {
		share.mutate({ id });
	}

	function handleSelectItem(itemId: string) {
		goto(`/items/${itemId}`);
	}
</script>

<Button onclick={handleShare}>Share</Button>
<Item onclick={() => handleSelectItem(item.id)} />

<!-- GOOD: Inlined at the call site -->
<Button onclick={() => share.mutate({ id })}>Share</Button>
<Item onclick={() => goto(`/items/${item.id}`)} />
```

This also applies to longer handlers. If the logic is linear (guard clauses + branches, not deeply nested), inline it even if it's 10–15 lines:

```svelte
<!-- GOOD: Inlined keyboard shortcut handler -->
<svelte:window onkeydown={(e) => {
	const meta = e.metaKey || e.ctrlKey;
	if (!meta) return;
	if (e.key === 'k') {
		e.preventDefault();
		commandPaletteOpen = !commandPaletteOpen;
		return;
	}
	if (e.key === 'n') {
		e.preventDefault();
		notesState.createNote();
	}
}} />
```

### The Exception: JSDoc + Semantic Name

Keep a single-use function extracted **only** when both conditions are met:

1. It has **JSDoc** explaining why it exists as a named unit.
2. The name provides a **clear semantic meaning** that makes the template more readable than the inlined version would be.

```svelte
<script lang="ts">
	/**
	 * Navigate the note list with arrow keys, wrapping at boundaries.
	 * Operates on the flattened display-order ID list to respect date grouping.
	 */
	function navigateWithArrowKeys(e: KeyboardEvent) {
		// 15 lines of keyboard navigation logic...
	}
</script>

<!-- The semantic name communicates intent better than inlined logic would -->
<div onkeydown={navigateWithArrowKeys} tabindex="-1">
```

Without JSDoc and a meaningful name, extract it anyway — the indirection isn't earning its keep.

### Multi-Use Functions

Functions used **2 or more times** should always stay extracted — this rule only applies to single-use functions.

# Styling

For general CSS and Tailwind guidelines, see the `styling` skill.

# shadcn-svelte Best Practices

## Component Organization

- Use the CLI: `bunx shadcn-svelte@latest add [component]`
- Each component in its own folder under `$lib/components/ui/` with an `index.ts` export
- Follow kebab-case for folder names (e.g., `dialog/`, `toggle-group/`)
- Group related sub-components in the same folder
- When using $state, $derived, or functions only referenced once in markup, inline them directly

## Import Patterns

**Namespace imports** (preferred for multi-part components):

```typescript
import * as Dialog from '$lib/components/ui/dialog';
import * as ToggleGroup from '$lib/components/ui/toggle-group';
```

**Named imports** (for single components):

```typescript
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
```

**Lucide icons** (always use individual imports from `@lucide/svelte`):

```typescript
// Good: Individual icon imports
import Database from '@lucide/svelte/icons/database';
import MinusIcon from '@lucide/svelte/icons/minus';
import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';

// Bad: Don't import multiple icons from lucide-svelte
import { Database, MinusIcon, MoreVerticalIcon } from 'lucide-svelte';
```

The path uses kebab-case (e.g., `more-vertical`, `minimize-2`), and you can name the import whatever you want (typically PascalCase with optional Icon suffix).

## Styling and Customization

- Always use the `cn()` utility from `$lib/utils` for combining Tailwind classes
- Modify component code directly rather than overriding styles with complex CSS
- Use `tailwind-variants` for component variant systems
- Follow the `background`/`foreground` convention for colors
- Leverage CSS variables for theme consistency

## Component Usage Patterns

Use proper component composition following shadcn-svelte patterns:

```svelte
<Dialog.Root bind:open={isOpen}>
	<Dialog.Trigger>
		<Button>Open</Button>
	</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Title</Dialog.Title>
		</Dialog.Header>
	</Dialog.Content>
</Dialog.Root>
```

## Custom Components

- When extending shadcn components, create wrapper components that maintain the design system
- Add JSDoc comments for complex component props
- Ensure custom components follow the same organizational patterns
- Consider semantic appropriateness (e.g., use section headers instead of cards for page sections)

# Props Pattern

## Always Inline Props Types

Never create a separate `type Props = {...}` declaration. Always inline the type directly in `$props()`:

```svelte
<!-- BAD: Separate Props type -->
<script lang="ts">
	type Props = {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	};

	let { selectedWorkspaceId, onSelect }: Props = $props();
</script>

<!-- GOOD: Inline props type -->
<script lang="ts">
	let { selectedWorkspaceId, onSelect }: {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	} = $props();
</script>
```

## Children Prop Never Needs Type Annotation

The `children` prop is implicitly typed in Svelte. Never annotate it:

```svelte
<!-- BAD: Annotating children -->
<script lang="ts">
	let { children }: { children: Snippet } = $props();
</script>

<!-- GOOD: children is implicitly typed -->
<script lang="ts">
	let { children } = $props();
</script>

<!-- GOOD: Other props need types, but children does not -->
<script lang="ts">
	let { children, title, onClose }: {
		title: string;
		onClose: () => void;
	} = $props();
</script>
```

# Self-Contained Component Pattern

## Prefer Component Composition Over Parent State Management

When building interactive components (especially with dialogs/modals), create self-contained components rather than managing state at the parent level.

### The Anti-Pattern (Parent State Management)

```svelte
<!-- Parent component -->
<script>
	let deletingItem = $state(null);
</script>

{#each items as item}
	<Button onclick={() => (deletingItem = item)}>Delete</Button>
{/each}

<AlertDialog open={!!deletingItem}>
	<!-- Single dialog for all items -->
</AlertDialog>
```

### The Pattern (Self-Contained Components)

```svelte
<!-- DeleteItemButton.svelte -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	let { item }: { item: Item } = $props();
	let open = $state(false);

	const deleteItem = createMutation(() => rpc.items.delete.options);
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		<Button>Delete</Button>
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<Button onclick={() => deleteItem.mutate({ id: item.id })}>
			Confirm Delete
		</Button>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Parent component -->
{#each items as item}
	<DeleteItemButton {item} />
{/each}
```

### Why This Pattern Works

- **No parent state pollution**: Parent doesn't need to track which item is being deleted
- **Better encapsulation**: All delete logic lives in one place
- **Simpler mental model**: Each row has its own delete button with its own dialog
- **No callbacks needed**: Component handles everything internally
- **Scales better**: Adding new actions doesn't complicate the parent

### When to Apply This Pattern

- Action buttons in table rows (delete, edit, etc.)
- Confirmation dialogs for list items
- Any repeating UI element that needs modal interactions
- When you find yourself passing callbacks just to update parent state

The key insight: It's perfectly fine to instantiate multiple dialogs (one per row) rather than managing a single shared dialog with complex state. Modern frameworks handle this efficiently, and the code clarity is worth it.

# Prop-First Data Derivation

When a component receives a prop that already carries the information needed for a decision, derive from the prop. Never reach into global state for data the component already has.

```svelte
<!-- BAD: Reading global state for info the prop already carries -->
<script lang="ts">
	import { viewState } from '$lib/state';
	let { note }: { note: Note } = $props();

	// viewState.isRecentlyDeletedView is redundant — note.deletedAt has the answer
	const showRestoreActions = $derived(viewState.isRecentlyDeletedView);
</script>

<!-- GOOD: Derive from the prop itself -->
<script lang="ts">
	let { note }: { note: Note } = $props();

	// The note knows its own state — no global state needed
	const isDeleted = $derived(note.deletedAt !== undefined);
</script>
```

### Why This Matters

- **Self-describing**: The component works correctly regardless of which view rendered it.
- **Fewer imports**: Dropping a global state import reduces coupling.
- **Testable**: Pass a note with `deletedAt` set and the component behaves correctly — no need to mock view state.

### The Rule

If the data needed for a decision is already on a prop (directly or derivable), **always** derive from the prop. Global state is for information the component genuinely doesn't have.

# View-Mode Branching Limit

If a component checks the same boolean flag (like `isRecentlyDeletedView`, `isEditing`, `isCompact`) in **3 or more template locations**, the component is likely serving two purposes and should be considered for extraction.

```svelte
<!-- SMELL: Same flag checked 3+ times -->
<script lang="ts">
	const notes = $derived(
		isRecentlyDeletedView ? deletedNotes : filteredNotes,  // branch 1
	);
</script>

{#if !isRecentlyDeletedView}  <!-- branch 2 -->
	<div>sort controls...</div>
{/if}

{#if isRecentlyDeletedView}  <!-- branch 3 -->
	No deleted notes
{:else}
	No notes yet
{/if}
```

### The Fix: Push Branching Up to the Parent

Move the view-mode decision to the parent. The child component takes the varying data as props:

```svelte
<!-- Parent: one branch point, explicit data flow -->
{#if viewState.isRecentlyDeletedView}
	<NoteList
		notes={notesState.deletedNotes}
		title="Recently Deleted"
		showControls={false}
		emptyMessage="No deleted notes"
	/>
{:else}
	<NoteList
		notes={viewState.filteredNotes}
		title={viewState.folderName}
	/>
{/if}
```

The child becomes dumb — it renders what it's told, with zero awareness of view modes. This keeps the branching in **one place** instead of scattered across the component tree.

### The Threshold

- **1–2 checks**: Acceptable — simple conditional rendering.
- **3+ checks on the same flag**: The component is likely two views in one. Consider pushing the varying data up as props.

# Data-Driven Repetitive Markup

When **3 or more sequential sibling elements** follow an identical pattern with only data varying, consider extracting the data into an array and using `{#each}` or a `{#snippet}`.

```svelte
<!-- BAD: Copy-paste ×3 with only value/label changing -->
<DropdownMenu.Item onclick={() => setSortBy('dateEdited')}>
	{#if sortBy === 'dateEdited'}<CheckIcon class="mr-2 size-4" />{/if}
	Date Edited
</DropdownMenu.Item>
<DropdownMenu.Item onclick={() => setSortBy('dateCreated')}>
	{#if sortBy === 'dateCreated'}<CheckIcon class="mr-2 size-4" />{/if}
	Date Created
</DropdownMenu.Item>
<DropdownMenu.Item onclick={() => setSortBy('title')}>
	{#if sortBy === 'title'}<CheckIcon class="mr-2 size-4" />{/if}
	Title
</DropdownMenu.Item>

<!-- GOOD: Data-driven with {#each} -->
<script lang="ts">
	const sortOptions = [
		{ value: 'dateEdited' as const, label: 'Date Edited' },
		{ value: 'dateCreated' as const, label: 'Date Created' },
		{ value: 'title' as const, label: 'Title' },
	];
</script>

{#each sortOptions as option}
	<DropdownMenu.Item onclick={() => setSortBy(option.value)}>
		{#if sortBy === option.value}
			<CheckIcon class="mr-2 size-4" />
		{:else}
			<span class="mr-2 size-4"></span>
		{/if}
		{option.label}
	</DropdownMenu.Item>
{/each}
```

For more complex repeated patterns (e.g., toolbar buttons with tooltips), use `{#snippet}` to define the shared structure once:

```svelte
{#snippet toggleButton(pressed: boolean, onToggle: () => void, icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Toggle size="sm" {pressed} onPressedChange={onToggle}>
				<svelte:component this={icon} class="size-4" />
			</Toggle>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{@render toggleButton(activeFormats.bold, () => editor?.chain().focus().toggleBold().run(), BoldIcon, 'Bold (⌘B)')}
{@render toggleButton(activeFormats.italic, () => editor?.chain().focus().toggleItalic().run(), ItalicIcon, 'Italic (⌘I)')}
```

### When NOT to Extract

- **2 or fewer** repetitions — extraction adds indirection without meaningful savings.
- **Structurally similar but semantically different** — if the elements serve different purposes and might diverge, keep them separate.
