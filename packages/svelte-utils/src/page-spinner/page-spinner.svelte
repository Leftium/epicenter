<!--
	Centered spinner panel with optional label. Layout-agnostic: callers
	pass the height via `class` so the same primitive serves boot screens,
	flex panes, and block panes without an `!important` escape hatch.

	@example
	```svelte
	<PageSpinner class="h-dvh" />                    full viewport (boot)
	<PageSpinner class="flex-1" />                   fills a flex parent
	<PageSpinner class="h-full" />                   fills a block parent
	<PageSpinner class="h-dvh" label="Loading…" />   with caption
	```
-->
<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';

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
