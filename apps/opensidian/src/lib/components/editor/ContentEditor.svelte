<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { workspace } from '$lib/client';
	import { fsState } from '$lib/state/fs-state.svelte';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';
	import { linkDecorations } from './extensions/link-decorations';
	import { wikilinkAutocomplete } from './extensions/wikilink-autocomplete';

	let {
		fileId,
	}: {
		fileId: FileId;
	} = $props();

	let handle = $state<DocumentHandle | null>(null);

	const extensions = [
		linkDecorations({
			onNavigate: (fileId) => fsState.selectFile(fileId),
			resolveTitle: (fileId) => fsState.getFile(fileId)?.name ?? null,
		}),
		wikilinkAutocomplete({
			getFiles: () =>
				workspace.tables.files
					.getAllValid()
					.filter((r) => r.type === 'file')
					.map((r) => ({ id: r.id, name: r.name })),
		}),
	];

	$effect(() => {
		const id = fileId;
		handle = null;
		workspace.documents.files.content.open(id).then((h) => {
			// Guard against race condition — if file changed while loading, ignore
			if (fsState.activeFileId !== id) return;
			handle = h;
		});
	});
</script>

{#if handle}
	<CodeMirrorEditor ytext={handle.asText()} {extensions} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
