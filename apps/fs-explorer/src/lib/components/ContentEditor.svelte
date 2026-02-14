<script lang="ts">
	import { fsState } from '$lib/fs/fs-state.svelte';
	import type { FileId } from '@epicenter/filesystem';
	import { onMount } from 'svelte';

	type Props = {
		fileId: FileId;
	};

	let { fileId }: Props = $props();

	let content = $state('');
	let loading = $state(true);
	let dirty = $state(false);

	async function loadContent() {
		loading = true;
		const result = await fsState.actions.readContent(fileId);
		// Guard against race condition — if file changed while loading, ignore
		if (fsState.activeFileId !== fileId) return;
		content = result ?? '';
		loading = false;
		dirty = false;
	}

	async function saveContent() {
		if (!dirty) return;
		await fsState.actions.writeContent(fileId, content);
		dirty = false;
	}

	function handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		content = target.value;
		dirty = true;
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			saveContent();
		}
	}

	// Load content when fileId changes
	$effect(() => {
		void fileId;
		loadContent();
	});
</script>

{#if loading}
	<div
		class="flex h-full items-center justify-center text-sm text-muted-foreground"
	>
		Loading...
	</div>
{:else}
	<textarea
		class="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-sm outline-none focus:ring-0"
		value={content}
		oninput={handleInput}
		onblur={saveContent}
		onkeydown={handleKeydown}
		spellcheck={false}
		placeholder="Empty file"
	></textarea>
{/if}
