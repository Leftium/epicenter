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
		const entries = createEntriesState({ table: folder.tables.entries });
		const chats = createChatsState({ tables: folder.tables });
		// Listen before the first read, so no change falls between them. Another
		// tab's saves arrive here as hints to read again. The folder drops the
		// listener when it closes.
		folder.onFilesChanged((paths) => {
			if (paths.some((path) => path.startsWith('entries/')))
				void entries.refresh();
			if (paths.some((path) => /^(chats|messages)\//.test(path)))
				void chats.refresh();
		});
		await Promise.all([entries.refresh(), chats.refresh()]);
		return { folder, entries, chats };
	});

	onDestroy(() => {
		// Every word's editor settles the work it admitted and lets go before
		// the folder does, so nothing lands on a closed folder.
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
