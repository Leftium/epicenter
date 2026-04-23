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
</script>

{#await handle.whenReady}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	<HoneycripEditor
		yxmlfragment={handle.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
