<script lang="ts">
	import { fromDocument } from '@epicenter/svelte';
	import { Spinner } from '@epicenter/ui/spinner';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { noteBodyDocs } from '$lib/client.svelte';
	import { notesState } from '$lib/state';

	let { noteId }: { noteId: string } = $props();

	const doc = fromDocument(noteBodyDocs, () => noteId);
</script>

{#await doc.current.whenReady}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
