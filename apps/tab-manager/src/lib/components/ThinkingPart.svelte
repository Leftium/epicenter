<script lang="ts">
	import * as Collapsible from '@epicenter/ui/collapsible';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let {
		content,
	}: {
		content: string;
	} = $props();
</script>

<Collapsible.Root>
	<Collapsible.Trigger
		class="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground"
	>
		<ChevronRightIcon
			class="size-3 transition-transform [[data-state=open]>&]:rotate-90"
		/>
		<BrainIcon class="size-3" />
		Thinking…
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div
			class="prose prose-sm mt-1 rounded-md bg-muted/30 p-2 text-xs text-muted-foreground"
		>
			{content}
		</div>
	</Collapsible.Content>
</Collapsible.Root>
