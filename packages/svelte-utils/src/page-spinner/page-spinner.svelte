<!--
	Full-viewport centered spinner, used at app boot moments where the page
	is intentionally blocked on a single async resource (auth bootstrap,
	workspace hydration). `Empty.Root` is repurposed here for layout: its
	default `flex-1` becomes `h-dvh flex-none` so this component owns the
	viewport rather than fitting a parent box.

	For loading states inside a pane that already has its own height, do NOT
	use this. Inline the 3-line `<div class="flex h-full items-center
	justify-center"><Spinner /></div>` idiom instead so the parent keeps
	control of layout.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';

	let {
		label,
		class: className,
	}: {
		/** Optional caption shown below the spinner (e.g. "Loading tabs…"). */
		label?: string;
		/** Extra classes merged onto Empty.Root. */
		class?: string;
	} = $props();
</script>

<Empty.Root
	class={cn('h-dvh flex-none border-0', className)}
	aria-live="polite"
>
	<Empty.Header>
		<Empty.Media>
			<Spinner class="size-5 text-muted-foreground" />
		</Empty.Media>
		{#if label}
			<Empty.Title class="text-sm font-normal text-muted-foreground">
				{label}
			</Empty.Title>
		{/if}
	</Empty.Header>
</Empty.Root>
