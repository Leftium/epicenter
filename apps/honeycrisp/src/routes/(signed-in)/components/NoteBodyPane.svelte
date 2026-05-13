<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { requireHoneycrisp } from '$lib/session';
	import type { NoteId } from '../honeycrisp/workspace';

	const honeycrisp = requireHoneycrisp();

	let { noteId }: { noteId: NoteId } = $props();

	const doc = fromDisposableCache(
		honeycrisp.noteBodyDocs,
		() => noteId,
	);
</script>

{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => honeycrisp.state.notes.updateContent(noteId, change)}
	/>
{/await}
