<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { openNotesHost } from '#platform/notes-host';
	import { onDestroy } from 'svelte';
	import { createNotes } from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	const opening = openNotesHost().then(async (host) => {
		const notes = createNotes(host);
		await notes.refreshAll();
		return notes;
	});

	onDestroy(() => {
		void opening.then((notes) => notes.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your notes…" />
{:then notes}
	<NotesView {notes} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the notes folder</Empty.Title>
		<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
	</Empty.Root>
{/await}
