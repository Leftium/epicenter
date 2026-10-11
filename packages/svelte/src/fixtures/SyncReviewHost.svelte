<!--
	A parent for mounted review tests: it shows and hides the review the way
	an app does, and hands back what the folder refused.
-->
<script lang="ts">
	import type { SyncAttempt, SyncChoiceProblem, SyncChoices } from '@epicenter/folder';
	import SyncReview from '../sync-review.svelte';

	let {
		attempt,
		onApply,
		controls,
	}: {
		attempt: SyncAttempt;
		onApply: (attempt: SyncAttempt, choices: SyncChoices) => void;
		controls: {
			reopen?: () => void;
			refuse?: (problems: readonly SyncChoiceProblem[]) => void;
		};
	} = $props();

	let open = $state(true);
	let problems = $state.raw<readonly SyncChoiceProblem[]>([]);
	$effect.pre(() => {
		controls.reopen = () => (open = true);
		controls.refuse = (refused) => (problems = refused);
	});
</script>

<SyncReview {attempt} {open} {problems} onBack={() => (open = false)} {onApply} />
