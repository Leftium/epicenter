<!--
	Region-level centered spinner. Fills its parent via `flex-1` (works in
	any flex container). For non-flex parents, pass `class="h-full
	!flex-none"` to switch to `height: 100%`.

	For full-page boot loading, use <PageSpinner> instead.
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
		/** Extra classes merged onto the wrapper. */
		class?: string;
	} = $props();
</script>

<div
	class={cn(
		'flex flex-1 flex-col items-center justify-center gap-3',
		className,
	)}
	aria-live="polite"
>
	<Spinner class="size-5 text-muted-foreground" />
	{#if label}
		<p class="text-sm text-muted-foreground">{label}</p>
	{/if}
</div>
