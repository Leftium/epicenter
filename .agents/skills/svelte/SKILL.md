---
name: svelte
description: Svelte 5 patterns including runes ($state, $derived, $props), TanStack Query, SvelteMap reactive state, shadcn-svelte components, and component composition. Use when the user mentions .svelte files, Svelte components, or when using TanStack Query, fromTable/fromKv, or shadcn-svelte UI.
metadata:
  author: epicenter
  version: '2.0'
---

# Svelte Guidelines

## Reference Repositories

- [Svelte](https://github.com/sveltejs/svelte) — Svelte 5 framework with runes and fine-grained reactivity
- [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte) — Port of shadcn/ui for Svelte with Bits UI primitives
- [shadcn-svelte-extras](https://github.com/ieedan/shadcn-svelte-extras) — Additional components for shadcn-svelte

> **Related Skills**: See `query-layer` for TanStack Query integration. See `styling` for CSS and Tailwind conventions.

## When to Apply This Skill

Use this pattern when you need to:

- Build Svelte 5 components that use TanStack Query mutations.
- Replace nested ternary `$derived` mappings with `satisfies Record` lookups.
- Decide between `createMutation` in `.svelte` and `.execute()` in `.ts`.
- Follow shadcn-svelte import, composition, and component organization patterns.
- Refactor one-off `handle*` wrappers into inline template actions.
- Convert SvelteMap data to arrays for derived state or component props.

## References

Load these on demand based on what you're working on:

- If working with **TanStack Query mutations** (`createMutation`, `.execute()`, `onSuccess`/`onError`), read [references/tanstack-query-mutations.md](references/tanstack-query-mutations.md)
- If working with **shadcn-svelte components** (imports, composition, styling, customization), read [references/shadcn-patterns.md](references/shadcn-patterns.md)
- If working with **reactive state modules** (`fromTable`, `fromKv`, `$derived` arrays, state factories), read [references/reactive-state-pattern.md](references/reactive-state-pattern.md)
- If working with **component architecture** (props, inlining handlers, self-contained components, view-mode branching, data-driven markup), read [references/component-patterns.md](references/component-patterns.md)
- If working with **loading or empty states** (`Spinner`, `Empty.*`, `{#await}` blocks), read [references/loading-empty-states.md](references/loading-empty-states.md)

---

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

# Styling

For general CSS and Tailwind guidelines, see the `styling` skill.
