<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { createChatsState } from '$lib/chat/chats.svelte.js';
	import { createEntriesState } from '$lib/entries.svelte.js';
	import { openVocabFolder } from '$lib/folder.js';
	import VocabShell from './components/VocabShell.svelte';

	// The mounted page opens the folder; importing modules opens nothing. There
	// is no sign-in on this path: words and chats are in this browser's folder
	// whether or not an account is signed in.
	const opening = openVocabFolder().then(async (folder) => {
		const entries = createEntriesState({ table: folder.tables.entries, files: folder.files });
		const chats = createChatsState(folder);
		// Read now; the shell reads again after its own actions and when the
		// learner returns to the window.
		await Promise.all([entries.refresh(), chats.refresh()]);
		return { folder, entries, chats };
	});

	onDestroy(() => {
		// The open word's saves land before the folder closes.
		void opening
			.then(async ({ folder, entries }) => {
				await entries.close();
				await folder.close();
			})
			.catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your words…" />
{:then vocab}
	<VocabShell {vocab} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open Vocab's folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}
