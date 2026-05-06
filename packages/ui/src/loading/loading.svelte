<!--
	Centered loading panel: spinner + optional caption. Layout-agnostic so
	the same primitive serves boot screens, flex panes, and block panes.
	Pairs with `Empty.Root`: one is the loading state, the other is the
	empty state of the same surface.

	@example
	```svelte
	<Loading class="h-dvh" />                    full viewport (boot)
	<Loading class="flex-1" />                   fills a flex parent
	<Loading class="h-full" />                   fills a block parent
	<Loading class="h-dvh" label="Loading…" />   with caption
	```
-->
<script lang="ts">
	import { Spinner } from '#/spinner';
	import { cn } from '#/utils.js';

	let {
		label,
		class: className,
	}: {
		/** Optional caption rendered below the spinner. */
		label?: string;
		/** Sizing + any extra classes merged onto the wrapper. */
		class?: string;
	} = $props();
</script>

<div
	class={cn('flex flex-col items-center justify-center gap-3', className)}
	aria-live="polite"
>
	<Spinner class="size-5 text-muted-foreground" />
	{#if label}
		<p class="text-sm text-muted-foreground">{label}</p>
	{/if}
</div>
