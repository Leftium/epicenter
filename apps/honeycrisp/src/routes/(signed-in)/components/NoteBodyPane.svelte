<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { PageSpinner } from '@epicenter/svelte/page-spinner';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispState } from '../state';
	import { getSignedIn } from '../signed-in';

	const signedIn = getSignedIn();
	const { notesState } = getHoneycrispState();

	let { noteId }: { noteId: string } = $props();

	const doc = fromDisposableCache(signedIn.honeycrisp.noteBodyDocs, () => noteId);
</script>

{#await doc.current.idb.whenLoaded}
	<PageSpinner class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
