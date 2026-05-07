<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getSignedInSession } from '$lib/session.svelte';
	import { getHoneycrispState } from '../state';

	const signedIn = getSignedInSession();
	const { notesState } = getHoneycrispState();

	let { noteId }: { noteId: string } = $props();

	const doc = fromDisposableCache(signedIn.honeycrisp.noteBodyDocs, () => noteId);
</script>

{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
