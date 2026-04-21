<script lang="ts">
	import { instructionsDocs } from '$lib/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	// Open a handle per skillId; dispose on switch so backgrounded skills stop
	// syncing after the grace period.
	let handle = $state<ReturnType<typeof instructionsDocs.open> | null>(null);

	$effect(() => {
		const h = instructionsDocs.open(skillId);
		handle = h;
		return () => {
			h.dispose();
			handle = null;
		};
	});
</script>

{#if handle}
	<CodeMirrorEditor ytext={handle.instructions.binding} />
{/if}
