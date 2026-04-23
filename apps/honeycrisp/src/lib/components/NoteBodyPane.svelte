<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { noteBodyDocs } from '$lib/client.svelte';
	import { notesState } from '$lib/state';

	let { noteId }: { noteId: string } = $props();

	// Parent wraps in {#key noteId}, so noteId is stable for this instance's
	// lifetime. Open once, dispose on unmount.
	const handle = noteBodyDocs.open(noteId);
	$effect(() => () => handle.dispose());

	// Wait for IDB hydration before revealing the editor — avoids a brief
	// empty-content flash where the editor renders against an unhydrated
	// Y.XmlFragment before local data loads.
	let isLoaded = $state(false);
	$effect(() => {
		let cancelled = false;
		handle.whenReady.then(() => {
			if (!cancelled) isLoaded = true;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

{#if isLoaded}
	<HoneycripEditor
		yxmlfragment={handle.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
