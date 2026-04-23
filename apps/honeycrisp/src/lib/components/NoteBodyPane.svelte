<script lang="ts">
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { noteBodyDocs } from '$lib/client.svelte';
	import { notesState } from '$lib/state';

	let { noteId }: { noteId: string } = $props();

	// Parent wraps in {#key noteId}, so noteId is stable for this instance's
	// lifetime. Open once, dispose on unmount.
	const handle = noteBodyDocs.open(noteId);
	$effect(() => () => handle.dispose());
</script>

<HoneycripEditor
	yxmlfragment={handle.body.binding}
	onContentChange={(change) => notesState.updateNoteContent(change)}
/>
