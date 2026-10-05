<script lang="ts">
	import type { Departure } from '$lib/departure.svelte.js';
	import DeparturePrompt from './DeparturePrompt.svelte';

	let { departure }: { departure: Departure } = $props();

	const leaving = $derived(
		departure.notice?.intent === 'restart'
			? 'Epicenter is restarting for an account change'
			: 'Epicenter is quitting',
	);
</script>

<!-- What this page answers when Epicenter asks to quit or restart. Editing waits meanwhile. -->
{#if departure.notice !== undefined}
	<div
		class="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-2 text-sm"
		role={departure.notice.stage === 'choose' ? 'alertdialog' : 'status'}
		aria-label="Leaving Epicenter"
	>
		{#if departure.notice.stage === 'saving'}
			<span>{leaving}. Saving your edits first; editing waits until it is done.</span>
		{:else if departure.notice.stage === 'ready'}
			<span>{leaving}. This window is ready; editing waits until Epicenter leaves or the {departure.notice.intent === 'restart' ? 'restart' : 'quit'} is cancelled.</span>
		{:else if departure.notice.stage === 'leaving'}
			<span>{leaving}.</span>
		{:else}
			<!-- A new prompt mounts a new instance; an earlier one is gone for good. -->
			{#key departure.notice.id}
				<DeparturePrompt {departure} prompt={departure.notice} />
			{/key}
		{/if}
	</div>
{/if}
