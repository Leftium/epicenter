<script lang="ts">
	import BrainIcon from '@lucide/svelte/icons/brain';
	import CollapsibleSection from './CollapsibleSection.svelte';

	let {
		content,
	}: {
		content: string;
	} = $props();
</script>

<CollapsibleSection
	label="Thinking…"
	contentClass="prose prose-sm bg-muted/30 text-muted-foreground"
>
	{#snippet icon()}
		<BrainIcon class="size-3" />
	{/snippet}
	{content}
</CollapsibleSection>
