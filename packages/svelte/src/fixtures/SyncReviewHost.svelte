<!--
	A parent for mounted review tests: it shows the review while an attempt
	waits, drops it on Cancel the way an app does, and hands back what the
	folder refused.
-->
<script lang="ts">
	import type { SyncAttempt, SyncChoiceProblem, SyncChoices } from '@epicenter/folder';
	import SyncReview from '../sync-review.svelte';

	let {
		attempt: initial,
		onApply,
		controls,
	}: {
		attempt: SyncAttempt;
		onApply: (attempt: SyncAttempt, choices: SyncChoices) => void;
		controls: {
			show?: (attempt: SyncAttempt) => void;
			refuse?: (problems: readonly SyncChoiceProblem[]) => void;
		};
	} = $props();

	let attempt = $state.raw<SyncAttempt | undefined>(undefined);
	let problems = $state.raw<readonly SyncChoiceProblem[]>([]);
	$effect.pre(() => {
		attempt = initial;
		controls.show = (next) => (attempt = next);
		controls.refuse = (refused) => (problems = refused);
	});
</script>

{#if attempt}
	{#key attempt.id}
		<SyncReview
			{attempt}
			{problems}
			onCancel={() => {
				attempt = undefined;
				problems = [];
			}}
			{onApply}
		/>
	{/key}
{/if}
