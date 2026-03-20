# Component Patterns

## When to Read This

Read when building Svelte components—handling props, inlining handlers, extracting self-contained components, or refactoring repetitive markup.

## Props Pattern

### Always Inline Props Types

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

### Children Prop Never Needs Type Annotation

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

## Self-Contained Component Pattern

### Prefer Component Composition Over Parent State Management

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

## View-Mode Branching Limit

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

## Data-Driven Repetitive Markup

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
