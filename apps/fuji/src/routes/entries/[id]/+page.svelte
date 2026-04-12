<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { DocumentHandle } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import { workspace } from '$lib/client';
	import EntryEditor from '$lib/components/EntryEditor.svelte';
	import { entriesState } from '$lib/entries.svelte';
	import type { EntryId } from '$lib/workspace';

	const entryId = $derived(page.params.id as EntryId);
	const entry = $derived(entryId ? (entriesState.get(entryId) ?? null) : null);

	let currentYXmlFragment = $state<Y.XmlFragment | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	// Redirect to list if entry doesn't exist (deleted, bad URL, etc.)
	$effect(() => {
		if (entryId && !entry) {
			// Wait a tick for CRDT data to hydrate before redirecting
			const timeout = setTimeout(() => {
				if (!entriesState.get(entryId)) {
					goto('/');
				}
			}, 500);
			return () => clearTimeout(timeout);
		}
	});

	$effect(() => {
		if (!entryId) {
			currentYXmlFragment = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspace.documents.entries.content.open(entryId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYXmlFragment = handle.asRichText();
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspace.documents.entries.content.close(entryId);
			}
			currentYXmlFragment = null;
			currentDocHandle = null;
		};
	});
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	{#if entry && currentYXmlFragment}
		{#key entryId}
			<EntryEditor {entry} yxmlfragment={currentYXmlFragment} />
		{/key}
	{:else}
		<div class="flex h-full items-center justify-center">
			<Spinner class="size-5 text-muted-foreground" />
		</div>
	{/if}
</main>
