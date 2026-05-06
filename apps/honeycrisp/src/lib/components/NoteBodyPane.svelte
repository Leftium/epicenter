<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Spinner } from '@epicenter/ui/spinner';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispState } from '$lib/state';
	import { getSignedIn } from '$lib/signed-in';

	const signedIn = getSignedIn();
	const { notesState } = getHoneycrispState();

	let { noteId }: { noteId: string } = $props();

	const doc = fromDisposableCache(signedIn.honeycrisp.noteBodyDocs, () => noteId);
</script>

{#await doc.current.idb.whenLoaded}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
